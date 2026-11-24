import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthService } from '../auth/service.js';
import type { BaseEnvironment } from '../config/env.js';
import { closeDatabases, openApp, type OpenedApp } from './app.js';
import { scheduleAuditCleanup } from './audit-cleanup.js';
import { RequestAudit } from './auth/audit.js';
import { webAuthConfig, type WebAuthOptions } from './auth/config.js';
import { DashboardAuth, redirect } from './auth/http.js';
import { HttpError, publicError } from './http-error.js';
import { setSecurityHeaders, validateOrigin } from './http.js';
import { dispatch } from './routes/index.js';
import type { App } from './routes/route.js';
import { Site } from './site.js';

interface Dependencies extends OpenedApp {
    site: Site;
    auth?: DashboardAuth;
    auditCleanup?: { stop(): void };
    closing: boolean;
}

type Session = NonNullable<ReturnType<DashboardAuth['authenticate']>>;

export interface Dashboard {
    url: string;
    close(): Promise<void>;
}

export async function startWebServer(env: BaseEnvironment, requestedPort = env.WEB_PORT, options: WebAuthOptions = {}): Promise<Dashboard> {
    const config = webAuthConfig(options, requestedPort);
    const site = await Site.load();
    const deps: Dependencies = { ...await openApp(env), site, closing: false };
    const server = createServer({ requestTimeout: 30_000 }, (req, res) => void serve(req, res, deps));
    const port = await listen(server, requestedPort, deps);
    if (config.origin.port === '0') config.origin.port = String(port);
    try {
        deps.auth = new DashboardAuth(new AuthService(deps.app.db, config.createProvider(config.origin)), config.origin);
    } catch (error) {
        await shutDown(server, deps);
        throw error;
    }
    deps.app.updates.start();
    deps.auditCleanup = scheduleAuditCleanup(deps.app.authStore);
    return { url: config.origin.origin, close: runOnce(() => shutDown(server, deps)) };
}

async function serve(req: IncomingMessage, res: ServerResponse, deps: Dependencies): Promise<void> {
    try {
        await handle(req, res, deps);
    } catch (error) {
        const failure = publicError(error);
        if (failure.status === 500) console.error('Dashboard request failed', error instanceof Error ? error.name : 'UnknownError');
        deps.site.serveFailure(req, res, failure);
    }
}

async function handle(req: IncomingMessage, res: ServerResponse, { app, site, auth, closing }: Dependencies): Promise<void> {
    setSecurityHeaders(res);
    if (closing || !auth) throw new HttpError(503, 'The dashboard is unavailable.');
    if (auth.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const { pathname, searchParams } = requestUrl(req);
    validateOrigin(req, auth.origin, isApi(pathname));
    if (site.servePublicAsset(req, res, pathname)) return;
    if (await auth.handle(req, res, pathname, searchParams)) return;
    const session = requireSession(req, res, auth, pathname);
    if (!session) return;
    if (pathname === '/auth/logout' && req.method === 'POST') return signOut(res, auth, session, app);
    if (app.env.MAINTENANCE_MODE) return site.serveMaintenance(req, res, pathname);
    if (site.servePage(req, res, pathname, session.user, app)) return;
    await dispatch(req.method, pathname, {
        req, res, query: searchParams, user: session.user,
        audit: new RequestAudit(app.db, app.authStore, session.user.id),
        sessionActive: () => Boolean(auth.service.session(session.token)),
    }, app);
}

function requireSession(req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, pathname: string): Session | undefined {
    const session = auth.authenticate(req);
    if (session) return session;
    if (req.method !== 'GET' || isApi(pathname)) throw new HttpError(401, 'Sign in to use Message Blaster.');
    redirect(res, '/login');
    return undefined;
}

function signOut(res: ServerResponse, auth: DashboardAuth, session: Session, app: App): void {
    auth.logout(res, session.token);
    app.updates.revalidate();
}

function isApi(pathname: string): boolean {
    return pathname.startsWith('/api/');
}

function requestUrl(req: IncomingMessage): URL {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid request path.');
    return new URL(req.url, 'http://127.0.0.1');
}

async function listen(server: Server, port: number, deps: Dependencies): Promise<number> {
    try {
        server.listen(port, '127.0.0.1');
        await once(server, 'listening');
        return (server.address() as AddressInfo).port;
    } catch (error) {
        closeDatabases(deps.databases);
        throw error;
    }
}

async function shutDown(server: Server, deps: Dependencies): Promise<void> {
    deps.closing = true;
    deps.auditCleanup?.stop();
    deps.app.updates.close();
    const stopped = new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    try {
        await Promise.all([deps.app.runner.close(), deps.app.whatsapp.close(), stopped]);
    } finally {
        closeDatabases(deps.databases);
    }
}

function runOnce<T>(action: () => Promise<T>): () => Promise<T> {
    let result: Promise<T> | undefined;
    return () => (result ??= action());
}
