import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthService } from '../../auth/service.js';
import { HttpError } from '../http-error.js';
import { json, noContent, respond } from '../http.js';

const ATTEMPT_WINDOW = 60_000;
const ATTEMPTS_PER_WINDOW = 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export class DashboardAuth {
    readonly #sessionCookie: string;
    readonly #flowCookie: string;
    #windowEnd = 0;
    #attempts = 0;

    constructor(readonly service: AuthService, readonly origin: URL) {
        const prefix = this.secure ? '__Host-' : '';
        this.#sessionCookie = `${prefix}blaster_session`;
        this.#flowCookie = `${prefix}blaster_login`;
    }

    get secure(): boolean {
        return this.origin.protocol === 'https:';
    }

    authenticate(req: IncomingMessage) {
        const token = cookie(req, this.#sessionCookie);
        const session = token && this.service.session(token);
        return session ? { ...session, token } : undefined;
    }

    async handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
        if (path === '/login' && req.method === 'GET') {
            if (this.authenticate(req)) redirect(res, '/');
            else loginPage(res, 200, query.has('denied') ? 'Sign-in failed or this account has not been approved.' : '');
        } else if (path === '/auth/google' && req.method === 'POST') {
            this.rateLimit(res);
            const flow = this.service.beginLogin();
            res.setHeader('Set-Cookie', this.setCookie(this.#flowCookie, flow.flowToken, flow.expiresAt));
            json(res, 200, { url: flow.url });
        } else if (path === '/auth/callback' && req.method === 'GET') {
            const cleared = this.setCookie(this.#flowCookie);
            const flowToken = cookie(req, this.#flowCookie);
            const state = query.get('state');
            const code = query.get('code');
            if (!flowToken || !state || !TOKEN.test(state)) {
                redirect(res, '/login?denied=1');
                return true;
            }
            const result = await this.service.completeLogin({ flowToken, state, code });
            if (result) {
                const previous = cookie(req, this.#sessionCookie);
                if (previous) this.service.logout(previous);
                res.setHeader('Set-Cookie', [cleared, this.setCookie(this.#sessionCookie, result.token, result.expiresAt)]);
            }
            redirect(res, result ? '/' : '/login?denied=1');
        } else {
            return false;
        }
        return true;
    }

    logout(res: ServerResponse, token: string): void {
        this.service.logout(token);
        res.setHeader('Set-Cookie', this.setCookie(this.#sessionCookie));
        noContent(res);
    }

    private setCookie(name: string, value = '', expiresAt = 0): string {
        const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`;
    }

    private rateLimit(res: ServerResponse): void {
        const now = Date.now();
        if (now >= this.#windowEnd) {
            this.#windowEnd = now + ATTEMPT_WINDOW;
            this.#attempts = 0;
        }
        if (++this.#attempts <= ATTEMPTS_PER_WINDOW) return;
        res.setHeader('Retry-After', String(Math.ceil((this.#windowEnd - now) / 1000)));
        throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.');
    }
}

export function redirect(res: ServerResponse, location: string): void {
    res.writeHead(303, { Location: location }).end();
}

function cookie(req: IncomingMessage, name: string): string | undefined {
    const prefix = `${name}=`;
    const cookies = req.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
    const value = cookies?.length === 1 ? cookies[0]!.slice(prefix.length) : undefined;
    return value && TOKEN.test(value) ? value : undefined;
}

function loginPage(res: ServerResponse, status: number, message: string): void {
    respond(res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Sign in · Message Blaster</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preload" href="/fonts/instrument.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/fonts/bricolage.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/login-bg-768.webp" as="image" type="image/webp" media="(max-width: 768px)"><link rel="preload" href="/login-bg-1376.webp" as="image" type="image/webp" media="(min-width: 769px)"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/auth.css"><script type="module" src="/login.mjs"></script></head>
<body class="auth-page">
    <div class="auth-bg" aria-hidden="true"></div>
    <main class="auth-card">
        <header class="auth-header">
            <div class="brand">
                <img class="brand-img" src="/logo.png" alt="Message Blaster" width="32" height="32">
                <span class="brand-name">Message Blaster</span>
            </div>
            <h1 class="auth-title">Welcome back</h1>
            <p class="auth-desc">Sign in with your approved Google account.</p>
        </header>

        <div id="login-alert" class="auth-alert" role="alert" ${message ? '' : 'hidden'}>
            <svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            <span id="login-error">${message}</span>
        </div>

        <button type="button" id="google-sign-in" class="google-btn">
            <svg class="google-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"/>
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24Z"/>
                <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15Z"/>
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98Z"/>
            </svg>
            <span class="btn-text">Continue with Google</span>
        </button>
    </main>

    <div class="toast" id="toast" role="status" hidden></div>
</body></html>`, 'text/html; charset=utf-8');
}
