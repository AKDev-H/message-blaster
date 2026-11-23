import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import makeWASocket, {
    DisconnectReason, jidNormalizedUser, proto, toNumber,
    type BinaryNode, type WAMessageKey, type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import { attachmentMimeType } from './attachment.service.js';
import type { MessageTransport, OutgoingMessage, ReceiptStage } from '../types/index.js';
import { acquireWhatsAppLease, openWhatsAppAuth, privateDirectory } from './whatsapp-auth.js';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const OPEN_TIMEOUT_MS = 45_000;
const PAIRING_TIMEOUT_MS = 120_000;
const SUBMISSION_TIMEOUT_MS = 90_000;
const RECOVERABLE_DISCONNECTS = new Set<number>([
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.restartRequired,
    DisconnectReason.unavailableService,
]);

function deferredConnection() {
    const result = Promise.withResolvers<void>();
    void result.promise.catch(() => {});
    return result;
}

function statusCode(error: unknown): number | undefined {
    return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const handleAbort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', handleAbort, { once: true });
    try {
        return await Promise.race([operation, aborted.promise]);
    } finally {
        signal.removeEventListener('abort', handleAbort);
    }
}

export class WhatsAppService implements MessageTransport {
    private readonly shutdown = new AbortController();
    private auth: ReturnType<typeof openWhatsAppAuth> | undefined;
    private authLease: DatabaseSync | undefined;
    private accountLease: DatabaseSync | undefined;
    private identity: string | undefined;
    private socket: WASocket | undefined;
    private opened = false;
    private online = deferredConnection();
    private background: Promise<void> | undefined;
    private release: Promise<void> | undefined;
    private failure: Error | undefined;

    constructor(
        private readonly authDir: string,
        private readonly logger: Logger,
        private readonly onReceipt: (messageId: string, stage: ReceiptStage) => void,
        private readonly allowPairing = false,
        /** Receives pairing QR codes instead of printing them, e.g. to show them in the dashboard. */
        private readonly onQr?: (qr: string) => void,
    ) {}

    get isReady(): boolean {
        return this.opened && this.socket?.ws.isOpen === true && !this.shutdown.signal.aborted && !this.failure;
    }

    get accountId(): string | undefined {
        return this.isReady ? this.identity : undefined;
    }

    get connectionError(): Error | undefined {
        return this.failure;
    }

    async connect(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        this.shutdown.signal.throwIfAborted();
        if (!this.background) {
            this.background = this.run().catch((error: unknown) => {
                this.fail(error instanceof Error ? error : new Error('WhatsApp connection failed.'));
            }).finally(() => {
                this.auth?.close();
                this.accountLease?.close();
                this.authLease?.close();
            });
        }
        try {
            await this.waitUntilReady(signal);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async waitUntilReady(signal?: AbortSignal): Promise<void> {
        if (this.failure) {
            throw this.failure;
        }
        const lifetime = this.shutdown.signal;
        await withAbort(this.online.promise, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
    }

    close(): Promise<void> {
        if (!this.release) {
            this.shutdown.abort(new Error('WhatsApp connection stopped.'));
            this.release = (async () => {
                try {
                    await this.socket?.end(undefined);
                } finally {
                    await this.background;
                }
            })();
        }
        return this.release;
    }

    async send(message: OutgoingMessage): Promise<void> {
        const socket = this.socket;
        if (!socket || !this.isReady) {
            throw new Error('WhatsApp is not connected.');
        }
        if (!/^\+[1-9]\d{5,14}$/.test(message.phone)) {
            throw new Error('A normalized international phone number is required.');
        }

        try {
            this.claimIdentity(socket.user?.id);
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error('WhatsApp linked account verification failed.'));
            throw error;
        }
        const jid = `${message.phone.slice(1)}@s.whatsapp.net`;
        const content = message.attachment
            ? {
                document: message.attachment.data,
                fileName: message.attachment.name,
                mimetype: attachmentMimeType(message.attachment.name),
                caption: message.text,
            }
            : { text: message.text, linkPreview: null };

        // An exception after invoking sendMessage may follow a successful network submission.
        const timeout = AbortSignal.timeout(SUBMISSION_TIMEOUT_MS);
        try {
            const submitted = await withAbort(
                socket.sendMessage(jid, content, {
                    messageId: message.id,
                    mediaUploadTimeoutMs: OPEN_TIMEOUT_MS,
                }),
                timeout,
            );
            if (submitted?.key.id !== message.id) {
                throw new Error('WhatsApp did not confirm the expected submission identifier.');
            }
        } catch (error) {
            if (timeout.aborted) {
                this.fail(new Error('WhatsApp submission timed out. Delivery is uncertain.'));
            }
            throw new Error('WhatsApp submission could not be confirmed.', { cause: error });
        }
    }

    private claimIdentity(jid: string | undefined): void {
        const normalized = jid && jidNormalizedUser(jid);
        if (!normalized) {
            throw new Error('WhatsApp did not provide a linked account identity.');
        }
        const identity = createHash('sha256').update(normalized).digest('hex');
        if (this.identity && this.identity !== identity) {
            throw new Error('The linked WhatsApp account changed. Restart and review the account.');
        }
        if (!this.accountLease) {
            this.accountLease = acquireWhatsAppLease(
                join(homedir(), '.whatsapp-bulk-sender', 'locks', `${identity}.sqlite`),
                'This WhatsApp account already has an active connection in this application.',
            );
        }
        this.identity = identity;
    }

    private async run(): Promise<void> {
        const directory = privateDirectory(this.authDir);
        this.authLease = acquireWhatsAppLease(
            join(directory, 'connection-lock.sqlite'),
            'Another command already owns this WhatsApp authentication directory.',
        );
        this.auth = openWhatsAppAuth(directory);
        const credentials = this.auth.state.creds;
        if (credentials.me?.id) {
            this.claimIdentity(credentials.me.id);
        } else if (!this.allowPairing) {
            throw new Error('WhatsApp is not paired. Run npm run whatsapp:connect to scan a QR code.');
        }

        let reconnects = 0;
        while (!this.shutdown.signal.aborted) {
            const result = await this.openSocket(this.auth);
            if (this.shutdown.signal.aborted || this.failure) {
                return;
            }

            const code = statusCode(result.error);
            if (code === DisconnectReason.loggedOut) {
                this.auth.markLoggedOut();
                throw new Error('WhatsApp logged out this session. Archive the auth directory and run whatsapp:connect to pair again.');
            }
            if (code === DisconnectReason.forbidden || code === DisconnectReason.multideviceMismatch) {
                throw new Error(`WhatsApp declined the connection (${code}). Review your account in WhatsApp.`);
            }
            if (!this.auth.state.creds.me?.id && !result.opened) {
                throw new Error('WhatsApp closed before pairing finished. Run whatsapp:connect again to get a new QR code.');
            }
            if (code === undefined || !RECOVERABLE_DISCONNECTS.has(code)) {
                throw new Error(`WhatsApp connection closed${code === undefined ? '' : ` (${code})`}. Review it before reconnecting.`);
            }

            const wait = RECONNECT_DELAYS_MS[reconnects++];
            if (wait === undefined) {
                throw new Error('WhatsApp reconnect attempts exhausted.');
            }
            this.logger.warn({ code, retryInMs: wait }, 'WhatsApp disconnected and will reconnect');
            try {
                await delay(wait, undefined, { signal: this.shutdown.signal });
            } catch (error) {
                if (!this.shutdown.signal.aborted) {
                    throw error;
                }
            }
        }
    }

    private async openSocket(auth: ReturnType<typeof openWhatsAppAuth>): Promise<{ error: unknown; opened: boolean }> {
        const socket = makeWASocket({
            auth: auth.state,
            // Baileys debug logs and protocol errors can contain account identifiers or QR data.
            logger: this.logger.child({ service: 'baileys' }, { level: 'silent' }),
            defaultQueryTimeoutMs: 30_000,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            syncFullHistory: false,
            enableAutoSessionRecreation: false,
            enableRecentMessageCache: false,
            maxMsgRetryCount: 0,
            getMessage: async () => undefined,
        });
        this.socket = socket;
        let opened = false;
        const closed = Promise.withResolvers<unknown>();
        const pairing = !auth.state.creds.me?.id;
        const timeout = setTimeout(() => {
            if (pairing) {
                this.fail(new Error('WhatsApp QR pairing timed out. Run whatsapp:connect again.'));
                return;
            }
            const reason = Object.assign(new Error('WhatsApp connection timed out.'), {
                output: { statusCode: DisconnectReason.timedOut },
            });
            void socket.end(reason).catch(() => {
                this.fail(new Error('Could not close the timed-out WhatsApp connection.'));
            });
        }, pairing ? PAIRING_TIMEOUT_MS : OPEN_TIMEOUT_MS);

        socket.ev.on('creds.update', () => {
            if (this.failure || this.shutdown.signal.aborted) {
                return;
            }
            try {
                if (auth.state.creds.me?.id) {
                    this.claimIdentity(auth.state.creds.me.id);
                }
                auth.saveCreds();
            } catch (error) {
                this.fail(error instanceof Error ? error : new Error('Could not store WhatsApp credentials.'));
            }
        });

        socket.ev.on('connection.update', ({ connection, qr, lastDisconnect, reachoutTimeLock }) => {
            if (connection === 'close') {
                clearTimeout(timeout);
                this.opened = false;
                if (opened && !this.failure && !this.shutdown.signal.aborted) {
                    this.online = deferredConnection();
                }
                closed.resolve(lastDisconnect?.error);
                return;
            }
            if (this.failure || this.shutdown.signal.aborted) {
                return;
            }
            if (reachoutTimeLock?.isActive) {
                this.fail(new Error('WhatsApp reports an account messaging restriction. Review the account in WhatsApp.'));
                return;
            }
            if (qr) {
                if (!this.allowPairing || this.identity || (!this.onQr && !process.stdout.isTTY)) {
                    this.fail(new Error('WhatsApp requires QR pairing. Run whatsapp:connect in an interactive terminal with a fresh auth directory.'));
                    return;
                }
                try {
                    if (this.onQr) this.onQr(qr);
                    else qrcode.generate(qr, { small: true });
                } catch {
                    this.fail(new Error('Could not display the WhatsApp pairing code.'));
                }
            }
            if (connection === 'open') {
                clearTimeout(timeout);
                try {
                    this.claimIdentity(socket.user?.id);
                    auth.saveCreds();
                    opened = true;
                    this.opened = true;
                    this.online.resolve();
                    this.logger.info('WhatsApp connected');
                } catch (error) {
                    this.fail(error instanceof Error ? error : new Error('WhatsApp linked account verification failed.'));
                }
            }
        });

        socket.ev.on('messages.update', updates => {
            for (const { key, update } of updates) {
                switch (update.status) {
                    case proto.WebMessageInfo.Status.ERROR:
                        this.report(key, 'REJECTED');
                        if (key.fromMe && update.messageStubParameters?.includes('463')) {
                            this.fail(new Error('WhatsApp rejected a message with account restriction code 463. Review the account in WhatsApp.'));
                        }
                        break;
                    case proto.WebMessageInfo.Status.SERVER_ACK:
                        this.report(key, 'ACKNOWLEDGED');
                        break;
                    case proto.WebMessageInfo.Status.DELIVERY_ACK:
                        this.report(key, 'DELIVERED');
                        break;
                    case proto.WebMessageInfo.Status.READ:
                    case proto.WebMessageInfo.Status.PLAYED:
                        this.report(key, 'READ');
                        break;
                }
            }
        });

        // In this Baileys release, successful message stanza ACKs do not always emit messages.update.
        socket.ws.on('CB:ack,class:message', ({ attrs }: BinaryNode) => {
            if (attrs.id && !attrs.error) {
                this.report({ id: attrs.id, fromMe: true }, 'ACKNOWLEDGED');
            }
        });

        socket.ev.on('message-receipt.update', updates => {
            for (const { key, receipt } of updates) {
                if (toNumber(receipt.readTimestamp ?? undefined) > 0 || toNumber(receipt.playedTimestamp ?? undefined) > 0) {
                    this.report(key, 'READ');
                } else if (toNumber(receipt.receiptTimestamp ?? undefined) > 0) {
                    this.report(key, 'DELIVERED');
                }
            }
        });

        const error = await closed.promise;
        this.socket = undefined;
        return { error, opened };
    }

    private report(key: WAMessageKey, stage: ReceiptStage): void {
        if (key.fromMe && key.id) {
            try {
                this.onReceipt(key.id, stage);
            } catch {
                this.fail(new Error('Could not persist a WhatsApp receipt. Check storage before resuming.'));
            }
        }
    }

    private fail(error: Error): void {
        if (this.failure || this.shutdown.signal.aborted) {
            return;
        }
        this.failure = error;
        this.opened = false;
        this.online.reject(error);
        this.logger.error({ message: error.message }, 'WhatsApp connection stopped');
        void this.socket?.end(undefined).catch(() => {
            this.logger.error('Could not close the WhatsApp socket cleanly');
        });
    }
}
