import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeEmail } from '../utils/email.util.js';
import type { GoogleIdentity, GoogleProvider } from './google.js';
import { AuthStore, type Session } from './store.js';

const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface LoginResponse {
    flowToken?: string | undefined;
    state?: string | null | undefined;
    code?: string | null | undefined;
}

function token(): string {
    return randomBytes(32).toString('base64url');
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
}

function isToken(value: string | null | undefined): value is string {
    return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function inviteAddress(identity: GoogleIdentity): string | undefined {
    try {
        const email = normalizeEmail(identity.email);
        if (email.endsWith('@gmail.com') || identity.hostedDomain) return email;
    } catch {
        return undefined;
    }
    return undefined;
}

export class AuthService {
    readonly store: AuthStore;
    #nextExpiryCleanup = 0;

    constructor(db: DatabaseSync, private readonly provider: GoogleProvider, private readonly now = Date.now) {
        this.store = new AuthStore(db);
    }

    beginLogin(): { url: string; flowToken: string; expiresAt: number } {
        const now = this.now();
        if (now >= this.#nextExpiryCleanup) {
            this.store.expire(now);
            this.#nextExpiryCleanup = now + FLOW_LIFETIME_MS;
        }
        const flowToken = token();
        const state = token();
        const nonce = token();
        const verifier = token();
        const expiresAt = now + FLOW_LIFETIME_MS;
        const url = this.provider.authorize({ state, nonce, challenge: hash(verifier) });
        this.store.saveFlow(hash(flowToken), hash(state), { nonce, verifier }, expiresAt);
        return { url, flowToken, expiresAt };
    }

    async completeLogin({ flowToken, state, code }: LoginResponse): Promise<(Session & { token: string }) | undefined> {
        const flow = isToken(flowToken) && isToken(state) && this.store.consumeFlow(hash(flowToken), hash(state), this.now());
        if (!flow || !code || code.length > 4096) return this.rejectLogin('denied');
        let identity: GoogleIdentity;
        try {
            identity = await this.provider.exchange({ code, verifier: flow.verifier });
        } catch {
            return this.rejectLogin('failed');
        }
        if (identity.nonce !== flow.nonce || !identity.emailVerified || !identity.subject) return this.rejectLogin('denied');
        const sessionToken = token();
        const expiresAt = this.now() + SESSION_LIFETIME_MS;
        const user = this.store.createSession(identity.subject, inviteAddress(identity), hash(sessionToken), expiresAt);
        return user && { token: sessionToken, expiresAt, user };
    }

    session(sessionToken: string | undefined): Session | undefined {
        if (isToken(sessionToken)) return this.store.session(hash(sessionToken), this.now());
        return undefined;
    }

    logout(sessionToken: string | undefined): void {
        if (isToken(sessionToken)) this.store.closeSession(hash(sessionToken));
    }

    private rejectLogin(outcome: 'denied' | 'failed'): undefined {
        this.store.audit({ action: 'auth.sign_in', outcome });
        return undefined;
    }
}
