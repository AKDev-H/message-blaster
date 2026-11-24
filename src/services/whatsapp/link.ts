import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import type { Environment } from '../../config/env.js';
import { errorMessage } from '../../utils/fs.util.js';
import { createLogger } from '../../utils/logger.js';
import { acquireWhatsAppLease } from './auth.js';
import type { WhatsAppService } from './service.js';

export type WhatsAppLinkStatus = 'unlinked' | 'pairing' | 'linked' | 'loggedOut';

export interface WhatsAppLinkState {
    status: WhatsAppLinkStatus;
    account?: string;
    qr?: string;
    error?: string;
}

type LinkSettings = Pick<Environment, 'AUTH_DIR' | 'LOG_DIR' | 'LOG_LEVEL'>;

const QR_STYLE = { type: 'svg', margin: 1, color: { dark: '#1e2a2b', light: '#ffffff' } } as const;

export function readWhatsAppAccount(authDir: string): { account?: string; loggedOut: boolean } {
    const path = join(authDir, 'auth-state.sqlite');
    if (!existsSync(path)) return { loggedOut: false };
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const credentials = readMeta(db, 'credentials');
        const number = credentials ? linkedNumber(String(credentials)) : undefined;
        return { loggedOut: Boolean(readMeta(db, 'logged-out')), ...(number ? { account: `+${number}` } : {}) };
    } finally {
        db.close();
    }
}

export class WhatsAppLinker {
    #session: WhatsAppService | undefined;
    #qr: string | undefined;
    #error: string | undefined;

    constructor(private readonly env: LinkSettings, private readonly onChange: () => void) {}

    state(): WhatsAppLinkState {
        if (this.#session) return { status: 'pairing', ...(this.#qr ? { qr: this.#qr } : {}) };
        const { account, loggedOut } = readWhatsAppAccount(this.env.AUTH_DIR);
        const status: WhatsAppLinkStatus = loggedOut ? 'loggedOut' : account ? 'linked' : 'unlinked';
        return { status, ...(account ? { account } : {}), ...(this.#error ? { error: this.#error } : {}) };
    }

    async start(): Promise<void> {
        if (this.#session) return;
        this.ensureCanLink();
        const session = await this.createSession();
        this.#session = session;
        this.#qr = undefined;
        this.#error = undefined;
        this.onChange();
        void this.pairInBackground(session);
    }

    async cancel(): Promise<void> {
        const session = this.#session;
        this.#session = undefined;
        this.#qr = undefined;
        this.#error = undefined;
        await session?.close();
        this.onChange();
    }

    async unlink(): Promise<void> {
        if (this.#session) throw new Error('Finish or cancel linking first.');
        if (!existsSync(this.env.AUTH_DIR)) return;
        acquireWhatsAppLease(join(this.env.AUTH_DIR, 'connection-lock.sqlite'), 'WhatsApp is in use by a running campaign. Pause it before unlinking.').close();
        await rename(this.env.AUTH_DIR, `${this.env.AUTH_DIR}-unlinked-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`);
        this.#error = undefined;
        this.onChange();
    }

    async close(): Promise<void> {
        await this.cancel();
    }

    private ensureCanLink(): void {
        const { status } = this.state();
        if (status === 'linked') throw new Error('WhatsApp is already linked. Unlink it before linking another number.');
        if (status === 'loggedOut') throw new Error('Unlink the logged-out session before linking again.');
    }

    private async createSession(): Promise<WhatsAppService> {
        const { WhatsAppService } = await import('./service.js');
        const logger = createLogger(this.env as Environment);
        const session: WhatsAppService = new WhatsAppService(this.env.AUTH_DIR, logger, () => {}, true, qr => this.showQr(session, qr));
        return session;
    }

    private showQr(session: WhatsAppService, qr: string): void {
        void QRCode.toString(qr, QR_STYLE).then(svg => {
            if (this.#session !== session) return;
            this.#qr = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
            this.onChange();
        });
    }

    private async pairInBackground(session: WhatsAppService): Promise<void> {
        try {
            await session.connect();
        } catch (error) {
            if (this.#session === session) this.#error = errorMessage(error, 'WhatsApp linking failed.');
        }
        await session.close();
        if (this.#session === session) {
            this.#session = undefined;
            this.#qr = undefined;
        }
        this.onChange();
    }
}

function readMeta(db: DatabaseSync, name: string) {
    try {
        return db.prepare('SELECT value FROM auth_meta WHERE name = ?').get(name)?.value;
    } catch {
        return undefined;
    }
}

function linkedNumber(credentials: string): string | undefined {
    const id = (JSON.parse(credentials) as { me?: { id?: string } }).me?.id;
    const number = id?.split(/[:@]/u)[0];
    return number && /^\d+$/u.test(number) ? number : undefined;
}
