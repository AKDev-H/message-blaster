import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import makeWASocket, {
    DisconnectReason, type BaileysEventMap, type BinaryNode, type WAMessageKey, type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import type { MessageTransport, OutgoingMessage, ReceiptStage } from '../../types/index.js';
import { attachmentMimeType } from '../attachment.service.js';
import { asError, deferred, withAbort } from './abort.js';
import { whatsappAccountId, whatsappJid } from './account.js';
import { acquireWhatsAppLease, openWhatsAppAuth, privateDirectory, type WhatsAppAuth } from './auth.js';
import { reconnectDelay, statusCode } from './disconnects.js';
import { RESTRICTION_CODE, stageOfReceipt, stageOfStatus } from './receipts.js';

const OPEN_TIMEOUT_MS = 45_000;
const PAIRING_TIMEOUT_MS = 120_000;
const SUBMISSION_TIMEOUT_MS = 90_000;

type ConnectionUpdate = BaileysEventMap['connection.update'];

interface SocketRun {
    socket: WASocket;
    auth: WhatsAppAuth;
    opened: boolean;
    closed: PromiseWithResolvers<unknown>;
    timeout?: NodeJS.Timeout;
}

export class WhatsAppService implements MessageTransport {
    private readonly shutdown = new AbortController();
    private auth: WhatsAppAuth | undefined;
    private authLease: DatabaseSync | undefined;
    private accountLease: DatabaseSync | undefined;
    private identity: string | undefined;
    private socket: WASocket | undefined;
    private opened = false;
    private online = deferred();
    private background: Promise<void> | undefined;
    private release: Promise<void> | undefined;
    private failure: Error | undefined;

    constructor(
        private readonly authDir: string,
        private readonly logger: Logger,
        private readonly onReceipt: (messageId: string, stage: ReceiptStage) => void,
        private readonly allowPairing = false,
        private readonly onQr?: (qr: string) => void,
    ) {}

    get isReady(): boolean {
        return this.opened && this.socket?.ws.isOpen === true && !this.stopped;
    }

    get accountId(): string | undefined {
        return this.isReady ? this.identity : undefined;
    }

    get connectionError(): Error | undefined {
        return this.failure;
    }

    private get stopped(): boolean {
        return Boolean(this.failure) || this.shutdown.signal.aborted;
    }


    async connect(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        this.shutdown.signal.throwIfAborted();
        this.background ??= this.runInBackground();
        try {
            await this.waitUntilReady(signal);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async waitUntilReady(signal?: AbortSignal): Promise<void> {
        if (this.failure) throw this.failure;
        const lifetime = this.shutdown.signal;
        await withAbort(this.online.promise, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
    }

    close(): Promise<void> {
        this.release ??= this.stop();
        return this.release;
    }

    private async stop(): Promise<void> {
        this.shutdown.abort(new Error('WhatsApp connection stopped.'));
        try {
            await this.socket?.end(undefined);
        } finally {
            await this.background;
        }
    }

    private runInBackground(): Promise<void> {
        return this.keepConnected()
            .catch((error: unknown) => this.fail(asError(error, 'WhatsApp connection failed.')))
            .finally(() => this.releaseFiles());
    }

    private releaseFiles(): void {
        this.auth?.close();
        this.accountLease?.close();
        this.authLease?.close();
    }

    private async keepConnected(): Promise<void> {
        const auth = this.openSession();
        for (let reconnects = 0; !this.shutdown.signal.aborted; reconnects++) {
            const closed = await this.openSocket(auth);
            if (this.stopped) return;
            const wait = reconnectDelay(closed, auth, reconnects);
            this.logger.warn({ code: statusCode(closed.error), retryInMs: wait }, 'WhatsApp disconnected and will reconnect');
            await this.sleep(wait);
        }
    }

    private openSession(): WhatsAppAuth {
        const directory = privateDirectory(this.authDir);
        this.authLease = acquireWhatsAppLease(join(directory, 'connection-lock.sqlite'),
            'Another command already owns this WhatsApp authentication directory.');
        this.auth = openWhatsAppAuth(directory);
        const linkedAccount = this.auth.state.creds.me?.id;
        if (linkedAccount) this.claimIdentity(linkedAccount);
        else if (!this.allowPairing) throw new Error('WhatsApp is not paired. Run npm run whatsapp:connect to scan a QR code.');
        return this.auth;
    }

    private async sleep(ms: number): Promise<void> {
        try {
            await delay(ms, undefined, { signal: this.shutdown.signal });
        } catch (error) {
            if (!this.shutdown.signal.aborted) throw error;
        }
    }


    async send(message: OutgoingMessage): Promise<void> {
        const socket = this.connectedSocket();
        if (!/^\+[1-9]\d{5,14}$/.test(message.phone)) throw new Error('A normalized international phone number is required.');
        this.verifyLinkedAccount(socket);
        await this.submit(socket, message);
    }

    private connectedSocket(): WASocket {
        if (!this.socket || !this.isReady) throw new Error('WhatsApp is not connected.');
        return this.socket;
    }

    private verifyLinkedAccount(socket: WASocket): void {
        try {
            this.claimIdentity(socket.user?.id);
        } catch (error) {
            this.fail(asError(error, 'WhatsApp linked account verification failed.'));
            throw error;
        }
    }

    private async submit(socket: WASocket, message: OutgoingMessage): Promise<void> {
        const timeout = AbortSignal.timeout(SUBMISSION_TIMEOUT_MS);
        const options = { messageId: message.id, mediaUploadTimeoutMs: OPEN_TIMEOUT_MS };
        try {
            const submitted = await withAbort(socket.sendMessage(whatsappJid(message.phone), messageContent(message), options), timeout);
            if (submitted?.key.id !== message.id) throw new Error('WhatsApp did not confirm the expected submission identifier.');
        } catch (error) {
            if (timeout.aborted) this.fail(new Error('WhatsApp submission timed out. Delivery is uncertain.'));
            throw new Error('WhatsApp submission could not be confirmed.', { cause: error });
        }
    }

    private claimIdentity(jid: string | undefined): void {
        const identity = jid ? whatsappAccountId(jid) : undefined;
        if (!identity) throw new Error('WhatsApp did not provide a linked account identity.');
        if (this.identity && this.identity !== identity) throw new Error('The linked WhatsApp account changed. Restart and review the account.');
        this.accountLease ??= acquireWhatsAppLease(join(homedir(), '.whatsapp-bulk-sender', 'locks', `${identity}.sqlite`),
            'This WhatsApp account already has an active connection in this application.');
        this.identity = identity;
    }


    private async openSocket(auth: WhatsAppAuth): Promise<{ error: unknown; opened: boolean }> {
        const socket = makeWASocket(socketOptions(auth, this.logger));
        const run: SocketRun = { socket, auth, opened: false, closed: Promise.withResolvers<unknown>() };
        this.socket = socket;
        run.timeout = this.startOpenTimeout(run);
        this.listen(run);
        const error = await run.closed.promise;
        this.socket = undefined;
        return { error, opened: run.opened };
    }

    private startOpenTimeout(run: SocketRun): NodeJS.Timeout {
        const pairing = !run.auth.state.creds.me?.id;
        return setTimeout(() => this.onOpenTimeout(run, pairing), pairing ? PAIRING_TIMEOUT_MS : OPEN_TIMEOUT_MS);
    }

    private onOpenTimeout(run: SocketRun, pairing: boolean): void {
        if (pairing) return this.fail(new Error('WhatsApp QR pairing timed out. Run whatsapp:connect again.'));
        const reason = Object.assign(new Error('WhatsApp connection timed out.'), { output: { statusCode: DisconnectReason.timedOut } });
        void run.socket.end(reason).catch(() => this.fail(new Error('Could not close the timed-out WhatsApp connection.')));
    }

    private listen(run: SocketRun): void {
        const { socket } = run;
        socket.ev.on('creds.update', () => this.onCredentialsUpdate(run.auth));
        socket.ev.on('connection.update', update => this.onConnectionUpdate(run, update));
        socket.ev.on('messages.update', updates => this.onMessageUpdates(updates));
        socket.ws.on('CB:ack,class:message', (node: BinaryNode) => this.onServerAck(node));
        socket.ev.on('message-receipt.update', updates => this.onReceiptUpdates(updates));
    }

    private onCredentialsUpdate(auth: WhatsAppAuth): void {
        if (this.stopped) return;
        try {
            if (auth.state.creds.me?.id) this.claimIdentity(auth.state.creds.me.id);
            auth.saveCreds();
        } catch (error) {
            this.fail(asError(error, 'Could not store WhatsApp credentials.'));
        }
    }

    private onConnectionUpdate(run: SocketRun, { connection, qr, lastDisconnect, reachoutTimeLock }: ConnectionUpdate): void {
        if (connection === 'close') return this.onClose(run, lastDisconnect?.error);
        if (this.stopped) return;
        if (reachoutTimeLock?.isActive) return this.fail(new Error('WhatsApp reports an account messaging restriction. Review the account in WhatsApp.'));
        if (qr && !this.showPairingCode(qr)) return;
        if (connection === 'open') this.onOpen(run);
    }

    private onClose(run: SocketRun, error: unknown): void {
        clearTimeout(run.timeout);
        this.opened = false;
        if (run.opened && !this.stopped) this.online = deferred();
        run.closed.resolve(error);
    }

    private onOpen(run: SocketRun): void {
        clearTimeout(run.timeout);
        try {
            this.markOnline(run);
        } catch (error) {
            this.fail(asError(error, 'WhatsApp linked account verification failed.'));
        }
    }

    private markOnline(run: SocketRun): void {
        this.claimIdentity(run.socket.user?.id);
        run.auth.saveCreds();
        run.opened = true;
        this.opened = true;
        this.online.resolve();
        this.logger.info('WhatsApp connected');
    }

    private showPairingCode(qr: string): boolean {
        if (!this.allowPairing || this.identity || (!this.onQr && !process.stdout.isTTY)) {
            this.fail(new Error('WhatsApp requires QR pairing. Run whatsapp:connect in an interactive terminal with a fresh auth directory.'));
            return false;
        }
        try {
            if (this.onQr) this.onQr(qr);
            else qrcode.generate(qr, { small: true });
        } catch {
            this.fail(new Error('Could not display the WhatsApp pairing code.'));
        }
        return true;
    }


    private onMessageUpdates(updates: BaileysEventMap['messages.update']): void {
        for (const { key, update } of updates) {
            const stage = stageOfStatus(update.status);
            if (stage) this.report(key, stage);
            if (stage === 'REJECTED' && key.fromMe && update.messageStubParameters?.includes(RESTRICTION_CODE)) {
                this.fail(new Error('WhatsApp rejected a message with account restriction code 463. Review the account in WhatsApp.'));
            }
        }
    }

    private onServerAck({ attrs }: BinaryNode): void {
        if (attrs.id && !attrs.error) this.report({ id: attrs.id, fromMe: true }, 'ACKNOWLEDGED');
    }

    private onReceiptUpdates(updates: BaileysEventMap['message-receipt.update']): void {
        for (const { key, receipt } of updates) {
            const stage = stageOfReceipt(receipt);
            if (stage) this.report(key, stage);
        }
    }

    private report(key: WAMessageKey, stage: ReceiptStage): void {
        if (!key.fromMe || !key.id) return;
        try {
            this.onReceipt(key.id, stage);
        } catch {
            this.fail(new Error('Could not persist a WhatsApp receipt. Check storage before resuming.'));
        }
    }

    private fail(error: Error): void {
        if (this.stopped) return;
        this.failure = error;
        this.opened = false;
        this.online.reject(error);
        this.logger.error({ message: error.message }, 'WhatsApp connection stopped');
        void this.socket?.end(undefined).catch(() => this.logger.error('Could not close the WhatsApp socket cleanly'));
    }
}

function socketOptions(auth: WhatsAppAuth, logger: Logger): Parameters<typeof makeWASocket>[0] {
    return {
        auth: auth.state,
        logger: logger.child({ service: 'baileys' }, { level: 'silent' }),
        defaultQueryTimeoutMs: 30_000,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        syncFullHistory: false,
        enableAutoSessionRecreation: false,
        enableRecentMessageCache: false,
        maxMsgRetryCount: 0,
        getMessage: async () => undefined,
    };
}

function messageContent(message: OutgoingMessage) {
    if (!message.attachment) return { text: message.text, linkPreview: null };
    const { data, name } = message.attachment;
    return { document: data, fileName: name, mimetype: attachmentMimeType(name), caption: message.text };
}
