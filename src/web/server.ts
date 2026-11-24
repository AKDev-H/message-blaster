import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { AuthService } from '../auth/service.js';
import type { BaseEnvironment } from '../config/env.js';
import { openDatabase } from '../database/connection.js';
import { WorkerBusyError } from '../errors.js';
import { recoverInterruptedCampaigns } from '../services/live-campaign.service.js';
import { migrateSettings, withSavedSettings } from '../services/settings.service.js';
import { WhatsAppLinker } from '../services/whatsapp/link.js';
import { Store } from '../store/index.js';
import { loadAssets, loadStatusPages, type Assets, type StatusPage, type StatusPages } from './assets.js';
import { RequestAudit } from './auth/audit.js';
import { webAuthConfig, type WebAuthOptions } from './auth/config.js';
import { DashboardAuth, redirect } from './auth/http.js';
import { HttpError, publicError } from './http-error.js';
import { json, sendAsset, sendError, sendPage, setSecurityHeaders, validateOrigin } from './http.js';
import { readCampaignId } from './input/index.js';
import { LiveUpdates } from './live-updates.js';
import { WebRunner } from './runner.js';
import { CAMPAIGN_PATH, campaignRoutes } from './routes/campaigns.js';
import { fileRoutes } from './routes/files.js';
import { findRoute, type App } from './routes/route.js';
import { settingsRoutes } from './routes/settings.js';

const ROUTES = [...campaignRoutes, ...fileRoutes, ...settingsRoutes];
const MAINTENANCE_RETRY_SECONDS = 120;
const PAGE_PREVIEWS: Record<string, [StatusPage, number]> = {
    '/errors/404': ['not-found', 404],
    '/errors/500': ['server-error', 500],
    '/errors/maintenance': ['maintenance', 503],
};

interface Site {
    assets: Assets;
    pages: StatusPages;
}

interface Listener {
    auth?: DashboardAuth;
    closing: boolean;
}

export interface Dashboard {
    url: string;
    close(): Promise<void>;
}

export async function startWebServer(env: BaseEnvironment, requestedPort = env.WEB_PORT, options: WebAuthOptions = {}): Promise<Dashboard> {
    const config = webAuthConfig(options, requestedPort);
    const site: Site = { assets: await loadAssets(), pages: await loadStatusPages() };
    const db = await openMainDatabase(env);
    const observer = openOrClose(env.DATABASE_URL, db);
    const app = createApp(env, db, observer);
    const listener: Listener = { closing: false };
    const server = createServer({ requestTimeout: 30_000 }, (req, res) => void serve(req, res, app, site, listener));
    const port = await listen(server, requestedPort, [observer, db]);
    if (config.origin.port === '0') config.origin.port = String(port);
    try {
        listener.auth = new DashboardAuth(new AuthService(db, config.createProvider(config.origin)), config.origin);
    } catch (error) {
        await shutDown(app, server, listener, [observer, db]);
        throw error;
    }
    app.updates.start();
    return { url: config.origin.origin, close: runOnce(() => shutDown(app, server, listener, [observer, db])) };
}

async function openMainDatabase(env: BaseEnvironment): Promise<DatabaseSync> {
    const db = openDatabase(env.DATABASE_URL);
    try {
        migrateSettings(db, env);
        await recoverInterruptedCampaigns(new Store(db), env.DATABASE_URL);
    } catch (error) {
        if (error instanceof WorkerBusyError) return db;
        db.close();
        throw error;
    }
    return db;
}

function openOrClose(path: string, other: DatabaseSync): DatabaseSync {
    try {
        return openDatabase(path);
    } catch (error) {
        other.close();
        throw error;
    }
}

function createApp(env: BaseEnvironment, db: DatabaseSync, observer: DatabaseSync): App {
    const store = new Store(db);
    const readVersion = observer.prepare('PRAGMA data_version');
    const settings = () => withSavedSettings(env, db);
    const updates = new LiveUpdates(() => Number(readVersion.get()?.data_version), () => app.snapshot());
    const runner = new WebRunner(store, settings, () => updates.changed());
    const app: App = {
        env, db, store, runner, updates, settings, templates: new Map(),
        whatsapp: new WhatsAppLinker(env, () => {}),
        snapshot: () => campaignSnapshot(app),
    };
    return app;
}

function campaignSnapshot({ env, store, runner, updates }: App) {
    const active = new Set(store.listActiveCampaignIds());
    if (runner.activeId) active.add(runner.activeId);
    return { dryRun: env.DRY_RUN, ai: Boolean(env.GROQ_API_KEY), revision: updates.revision, active: [...active] };
}

async function serve(req: IncomingMessage, res: ServerResponse, app: App, site: Site, listener: Listener) {
    try {
        await route(req, res, app, site, listener);
    } catch (error) {
        const failure = publicError(error);
        if (failure.status === 500) console.error('Dashboard request failed', error instanceof Error ? error.name : 'UnknownError');
        if (res.headersSent) res.destroy();
        else if (wantsPage(req) && failure.status === 404) sendPage(res, 404, site.pages.get('not-found')!);
        else if (wantsPage(req) && failure.status >= 500) sendPage(res, failure.status, site.pages.get('server-error')!);
        else sendError(res, failure);
    }
}

async function route(req: IncomingMessage, res: ServerResponse, app: App, site: Site, listener: Listener) {
    setSecurityHeaders(res);
    const auth = listener.auth;
    if (listener.closing || !auth) throw new HttpError(503, 'The dashboard is unavailable.');
    if (auth.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const { pathname, searchParams } = requestUrl(req);
    const isApiCall = pathname.startsWith('/api/');
    validateOrigin(req, auth.origin, isApiCall);
    const asset = site.assets.get(pathname);
    if (req.method === 'GET' && ['/auth.css', '/login.mjs', '/login-bg.jpg', '/logo.png', '/favicon.svg'].includes(pathname) && asset) return sendAsset(req, res, asset);
    if (await auth.handle(req, res, pathname, searchParams)) return;
    const session = auth.authenticate(req);
    if (!session) {
        if (req.method === 'GET' && !isApiCall) return redirect(res, '/login');
        throw new HttpError(401, 'Sign in to use Message Blaster.');
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
        auth.logout(res, session.token);
        app.updates.revalidate();
        return;
    }
    if (pathname === '/audit' || pathname === '/api/audit') {
        if (session.user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
    }
    if (app.env.MAINTENANCE_MODE) return underMaintenance(req, res, site, pathname);
    if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user: session.user });
    if (pathname === '/api/audit' && req.method === 'GET') return auditPage(res, auth, searchParams);
    if (req.method === 'GET' && asset) {
        if (asset.type.startsWith('text/html')) return sendPage(res, 200, asset.body);
        return sendAsset(req, res, asset);
    }
    const preview = PAGE_PREVIEWS[pathname];
    if (req.method === 'GET' && preview) return sendPage(res, preview[1], site.pages.get(preview[0])!);
    const match = findRoute(ROUTES, req.method, pathname);
    if (!match) throw notFound(pathname);
    const audit = new RequestAudit(app.db, auth.service.store, session.user.id);
    await match.route.handle({
        req, res, params: match.params, query: searchParams, audit,
        sessionActive: () => Boolean(auth.service.session(session.token)),
    }, app);
}

function auditPage(res: ServerResponse, auth: DashboardAuth, query: URLSearchParams): void {
    const cursor = query.get('before');
    const before = cursor === null ? undefined : Number(cursor);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new HttpError(400, 'Invalid audit cursor.');
    const limit = 50;
    const events = auth.service.store.listAudit(before, limit + 1);
    const page = events.slice(0, limit);
    json(res, 200, { events: page, next: events.length > limit ? page.at(-1)?.id : null });
}

function underMaintenance(req: IncomingMessage, res: ServerResponse, site: Site, pathname: string): void {
    const asset = site.assets.get(pathname);
    if (req.method === 'GET' && asset && !asset.type.startsWith('text/html')) return sendAsset(req, res, asset);
    res.setHeader('Retry-After', String(MAINTENANCE_RETRY_SECONDS));
    if (pathname.startsWith('/api/')) return sendError(res, new HttpError(503, 'Message Blaster is down for maintenance. Try again in a few minutes.'));
    sendPage(res, 503, site.pages.get('maintenance')!);
}

function wantsPage(req: IncomingMessage): boolean {
    const path = req.url ?? '';
    return req.method === 'GET' && !path.startsWith('/api/') && String(req.headers.accept ?? '').includes('text/html');
}

function requestUrl(req: IncomingMessage): URL {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid request path.');
    return new URL(req.url, 'http://127.0.0.1');
}

function notFound(pathname: string): HttpError {
    const campaign = CAMPAIGN_PATH.exec(pathname);
    if (!campaign) return new HttpError(404, 'This page does not exist.');
    readCampaignId(campaign[1]!);
    return new HttpError(404, 'This action does not exist.');
}

async function listen(server: Server, port: number, databases: DatabaseSync[]): Promise<number> {
    try {
        server.listen(port, '127.0.0.1');
        await once(server, 'listening');
        return (server.address() as AddressInfo).port;
    } catch (error) {
        databases.forEach(db => db.close());
        throw error;
    }
}

async function shutDown(app: App, server: Server, listener: { closing: boolean }, databases: DatabaseSync[]): Promise<void> {
    listener.closing = true;
    app.updates.close();
    const stopped = new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    try {
        await Promise.all([app.runner.close(), app.whatsapp.close(), stopped]);
    } finally {
        databases.forEach(db => db.close());
    }
}

function runOnce<T>(action: () => Promise<T>): () => Promise<T> {
    let result: Promise<T> | undefined;
    return () => (result ??= action());
}
