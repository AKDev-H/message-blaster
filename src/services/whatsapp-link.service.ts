import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import type { Environment } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { acquireWhatsAppLease } from './whatsapp-auth.js';
import type { WhatsAppService } from './whatsapp.service.js';

export type WhatsAppLinkStatus = 'unlinked' | 'pairing' | 'linked' | 'loggedOut';

export interface WhatsAppLinkState {
    status: WhatsAppLinkStatus;
    account?: string;
    qr?: string;
    error?: string;
}

export function readWhatsAppAccount(authDir: string): { account?: string; loggedOut: boolean } {
    const path = join(authDir, 'auth-state.sqlite');
    if (!existsSync(path)) return { loggedOut: false };
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const meta = (name: string) => {
            try {
                return db.prepare('SELECT value FROM auth_meta WHERE name = ?').get(name)?.value;
            } catch {
                return undefined;
            }
        };
        const loggedOut = Boolean(meta('logged-out'));
        const credentials = meta('credentials');
        const id = credentials ? (JSON.parse(String(credentials)) as { me?: { id?: string } }).me?.id : undefined;
        const number = id?.split(/[:@]/u)[0];
        return { loggedOut, ...(number && /^\d+$/u.test(number) ? { account: `+${number}` } : {}) };
    } finally {
        db.close();
    }
}

export class WhatsAppLinker {
    #session: WhatsAppService | undefined;
    #qr: string | undefined;
    #error: string | undefined;

    constructor(private readonly env: Pick<Environment, 'AUTH_DIR' | 'LOG_DIR' | 'LOG_LEVEL'>, private readonly onChange: () => void) {}

    state(): WhatsAppLinkState {
        if (this.#session) return { status: 'pairing', ...(this.#qr ? { qr: this.#qr } : {}) };
        const { account, loggedOut } = readWhatsAppAccount(this.env.AUTH_DIR);
        const status: WhatsAppLinkStatus = loggedOut ? 'loggedOut' : account ? 'linked' : 'unlinked';
        return { status, ...(account ? { account } : {}), ...(this.#error ? { error: this.#error } : {}) };
    }

    async start(): Promise<void> {
        if (this.#session) return;
        const { status } = this.state();
        if (status === 'linked') throw new Error('WhatsApp is already linked. Unlink it before linking another number.');
        if (status === 'loggedOut') throw new Error('Unlink the logged-out session before linking again.');
        const { WhatsAppService } = await import('./whatsapp.service.js');
        const session = new WhatsAppService(this.env.AUTH_DIR, createLogger(this.env as Environment), () => {}, true, qr => {
            void QRCode.toString(qr, { type: 'svg', margin: 1, color: { dark: '#1e2a2b', light: '#ffffff' } }).then(svg => {
                if (this.#session !== session) return;
                this.#qr = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
                this.onChange();
            });
        });
        this.#session = session;
        this.#qr = undefined;
        this.#error = undefined;
        this.onChange();
        void session.connect().catch((error: unknown) => {
            if (this.#session === session) this.#error = error instanceof Error ? error.message : 'WhatsApp linking failed.';
        }).finally(async () => {
            await session.close();
            if (this.#session === session) {
                this.#session = undefined;
                this.#qr = undefined;
            }
            this.onChange();
        });
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
        const lease = acquireWhatsAppLease(join(this.env.AUTH_DIR, 'connection-lock.sqlite'),
            'WhatsApp is in use by a running campaign. Pause it before unlinking.');
        lease.close();
        await rename(this.env.AUTH_DIR, `${this.env.AUTH_DIR}-unlinked-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`);
        this.#error = undefined;
        this.onChange();
    }

    async close(): Promise<void> {
        await this.cancel();
    }
}
