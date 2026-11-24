import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { getCountries } from 'libphonenumber-js';
import type { Environment } from '../config/env.js';
import { openDatabase } from '../database/connection.js';
import { AiError, generateDraft } from '../services/ai.service.js';
import { attachmentMimeType, readAttachment } from '../services/attachment.service.js';
import { exportCampaignWorkbook } from '../services/campaign.service.js';
import { createExcelTemplate } from '../services/excel.service.js';
import { recoverInterruptedCampaigns } from '../services/live-campaign.service.js';
import { Store } from '../services/message.service.js';
import { saveSettings, withSavedSettings } from '../services/settings.service.js';
import { WhatsAppLinker } from '../services/whatsapp-link.service.js';
import type { CampaignChannel } from '../types/index.js';
import {
    campaignTargets, HttpError, listAttachments, previewDraft, readCampaignId, readChannel, readChannels, readDraft, readDraftRequest,
    readForm, readGmailSettings, readJson, readSendingSettings, storeAttachment,
} from './input.js';
import { WebRunner } from './runner.js';

const excelType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const scriptType = 'text/javascript; charset=utf-8';
const fontType = 'font/woff2';
const fonts = '../../node_modules/@fontsource-variable';
const assetPaths: readonly (readonly [string, string, string])[] = [
    ['/', '../../web/index.html', 'text/html; charset=utf-8'],
    ['/style.css', '../../web/style.css', 'text/css; charset=utf-8'],
    ...['app', 'brands', 'campaigns', 'compose', 'confirm', 'editor', 'icons', 'recipients', 'settings', 'ui', 'viewer'].map(name => [`/${name}.mjs`, `../../web/${name}.mjs`, scriptType] as const),
    ['/vendor/lucide.js', '../../node_modules/lucide/dist/umd/lucide.min.js', scriptType],
    ['/vendor/mammoth.js', '../../node_modules/mammoth/mammoth.browser.min.js', scriptType],
    ['/vendor/exceljs.js', '../../node_modules/exceljs/dist/exceljs.min.js', scriptType],
    ['/fonts/bricolage.woff2', `${fonts}/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2`, fontType],
    ['/fonts/instrument.woff2', `${fonts}/instrument-sans/files/instrument-sans-latin-standard-normal.woff2`, fontType],
    ['/fonts/instrument-italic.woff2', `${fonts}/instrument-sans/files/instrument-sans-latin-standard-italic.woff2`, fontType],
];

function respond(res: ServerResponse, status: number, body: Buffer | string, contentType: string) {
    res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown) {
    respond(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function workbookResponse(res: ServerResponse, data: Buffer, name: string) {
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    respond(res, 200, data, excelType);
}

function publicError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof AiError) return new HttpError(502, error.message);
    if (error instanceof Error && !('code' in error)) {
        if (/does not exist/i.test(error.message)) return new HttpError(404, error.message);
        if (/already exists$/u.test(error.message)) return new HttpError(409, 'A campaign already uses this name.', 'id');
        if (/^(Campaign|Cannot|Only|Use a registered|Another live campaign)/u.test(error.message)) {
            return new HttpError(409, error.message);
        }
    }
    return new HttpError(500, 'Something went wrong. Try again.');
}

function attachmentResponse(res: ServerResponse, name: string, data: Buffer, download: boolean) {
    const type = attachmentMimeType(name);
    const pdf = type === 'application/pdf';
    res.setHeader('Content-Security-Policy', pdf
        ? "default-src 'none'; frame-ancestors 'self'"
        : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'");
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    respond(res, 200, data, type.startsWith('text/') ? `${type}; charset=utf-8` : type);
}

function setHeaders(res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

function validateOrigin(req: IncomingMessage, port: number, protectsData: boolean) {
    const { host, origin } = req.headers;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new HttpError(403, 'Open the dashboard at its local address.');
    }
    if (protectsData && ((origin !== undefined && origin !== `http://${host}`) ||
        ['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site'])))) {
        throw new HttpError(403, 'This request must come from the dashboard.');
    }
}

export async function startWebServer(env: Environment, requestedPort = env.WEB_PORT) {
    const assets = new Map<string, { body: Buffer; type: string }>(await Promise.all(assetPaths.map(async ([route, path, type]) => [
        route, { body: await readFile(new URL(path, import.meta.url)), type },
    ] as const)));
    const templates = new Map<CampaignChannel | 'both', Promise<Buffer>>();
    const db = openDatabase(env.DATABASE_URL);
    try {
        await recoverInterruptedCampaigns(new Store(db), env.DATABASE_URL);
    } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('Another live campaign')) {
            db.close();
            throw error;
        }
    }

    let observer: DatabaseSync;
    try {
        observer = openDatabase(env.DATABASE_URL);
    } catch (error) {
        db.close();
        throw error;
    }
    const store = new Store(db);
    const readVersion = observer.prepare('PRAGMA data_version');
    const subscribers = new Set<ServerResponse>();
    const blocked = new Set<ServerResponse>();
    const pending = new Set<ServerResponse>();
    let version: number | undefined;
    let revision = 0;
    let port = requestedPort;
    let dirty = true;
    let closing = false;
    let broadcastQueued = false;
    const settings = () => withSavedSettings(env, db);
    const runner = new WebRunner(store, settings, changed);
    const whatsapp = new WhatsAppLinker(env, () => {});

    function publicSettings() {
        const current = settings();
        return {
            gmail: { user: current.GMAIL_USER, passwordSet: Boolean(current.GMAIL_APP_PASSWORD) },
            whatsapp: whatsapp.state(),
            sending: { country: current.DEFAULT_COUNTRY, delaySeconds: current.MESSAGE_DELAY_MS / 1_000 },
            countries: getCountries(),
        };
    }

    function snapshot() {
        return { dryRun: env.DRY_RUN, ai: Boolean(env.GROQ_API_KEY), revision, campaigns: store.listCampaignSummaries().map(campaign => runner.decorate(campaign)) };
    }

    function changed() {
        if (closing) return;
        dirty = true;
        if (broadcastQueued) return;
        broadcastQueued = true;
        queueMicrotask(() => {
            broadcastQueued = false;
            publishSafely();
        });
    }

    function publish() {
        if (closing || subscribers.size === 0) return;
        const current = Number(readVersion.get()?.data_version);
        if (!dirty && current === version) return;
        version = current;
        dirty = false;
        revision += 1;
        const event = snapshotEvent();
        for (const client of subscribers) writeEvent(client, event);
    }

    function publishSafely() {
        try {
            publish();
        } catch (error) {
            console.error('Campaign progress update failed', error);
            dirty = true;
        }
    }

    function snapshotEvent() {
        return `data: ${JSON.stringify(snapshot())}\n\n`;
    }

    function writeEvent(client: ServerResponse, event: string, isUpdate = true) {
        if (blocked.has(client)) {
            if (isUpdate) pending.add(client);
            return;
        }
        if (!client.write(event)) {
            blocked.add(client);
            client.once('drain', () => {
                blocked.delete(client);
                if (pending.delete(client) && !closing) publishClient(client);
            });
        }
    }

    function publishClient(client: ServerResponse) {
        try {
            writeEvent(client, snapshotEvent());
        } catch {
            client.destroy();
        }
    }

    function subscribe(res: ServerResponse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        subscribers.add(res);
        res.on('close', () => {
            subscribers.delete(res);
            blocked.delete(res);
            pending.delete(res);
        });
        writeEvent(res, `retry: 2000\n${snapshotEvent()}`);
    }

    async function route(req: IncomingMessage, res: ServerResponse) {
        setHeaders(res);
        if (closing) throw new HttpError(503, 'The dashboard is shutting down.');
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid request path.');
        const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');
        const method = req.method;
        validateOrigin(req, port, pathname.startsWith('/api/'));

        const asset = assets.get(pathname);
        if (method === 'GET' && asset) return respond(res, 200, asset.body, asset.type);
        if (method === 'GET' && pathname === '/api/events') return subscribe(res);
        if (method === 'GET' && pathname === '/api/campaigns') return json(res, 200, snapshot());
        if (method === 'GET' && pathname === '/api/template') {
            const requested = searchParams.get('channel') ?? 'gmail';
            const channel = requested === 'both' ? requested : readChannel(requested);
            let template = templates.get(channel);
            if (!template) {
                template = createExcelTemplate(channel, true).catch(error => {
                    templates.delete(channel);
                    throw error;
                });
                templates.set(channel, template);
            }
            return workbookResponse(res, await template, `message-blaster-${channel}-sample.xlsx`);
        }
        if (pathname === '/api/attachments' && method === 'GET') {
            return json(res, 200, { files: await listAttachments(env.ATTACHMENTS_DIR) });
        }
        const attachment = /^\/api\/attachments\/([^/]+)$/u.exec(pathname);
        if (attachment?.[1] && method === 'GET') {
            let name: string;
            try {
                name = decodeURIComponent(attachment[1]);
            } catch {
                throw new HttpError(400, 'Invalid attachment name.');
            }
            const file = await readAttachment(env.ATTACHMENTS_DIR, name).catch((error: unknown) => {
                throw new HttpError(404, error instanceof Error ? error.message : 'Attachment was not found.');
            });
            return attachmentResponse(res, file.name, file.data, searchParams.has('download'));
        }
        if (pathname === '/api/settings' && method === 'GET') return json(res, 200, publicSettings());
        if (pathname === '/api/settings/gmail' && method === 'PUT') {
            saveSettings(db, readGmailSettings(await readJson(req), Boolean(settings().GMAIL_APP_PASSWORD)));
            return json(res, 200, publicSettings());
        }
        if (pathname === '/api/settings/gmail/verify' && method === 'POST') {
            const { GmailService } = await import('../services/gmail.service.js');
            try {
                await new GmailService(settings()).connect();
            } catch (error) {
                throw new HttpError(502, error instanceof Error ? error.message : 'Could not connect to Gmail.');
            }
            return json(res, 200, { ok: true });
        }
        if (pathname === '/api/settings/sending' && method === 'PUT') {
            saveSettings(db, readSendingSettings(await readJson(req)));
            return json(res, 200, publicSettings());
        }
        if (pathname === '/api/settings/whatsapp/link' && (method === 'POST' || method === 'DELETE')) {
            try {
                await (method === 'POST' ? whatsapp.start() : whatsapp.cancel());
            } catch (error) {
                throw new HttpError(409, error instanceof Error ? error.message : 'Could not link WhatsApp.');
            }
            return json(res, 200, publicSettings());
        }
        if (pathname === '/api/settings/whatsapp/unlink' && method === 'POST') {
            try {
                await whatsapp.unlink();
            } catch (error) {
                throw new HttpError(409, error instanceof Error ? error.message : 'Could not unlink WhatsApp.');
            }
            return json(res, 200, publicSettings());
        }
        if (pathname === '/api/attachments' && method === 'POST') {
            const name = await storeAttachment(env.ATTACHMENTS_DIR, await readForm(req));
            return json(res, 201, { name });
        }
        if (pathname === '/api/drafts/generate' && method === 'POST') {
            return json(res, 200, await generateDraft(env, readDraftRequest(await readJson(req, 64 * 1024))));
        }
        if (pathname === '/api/campaigns' && method === 'POST') {
            const form = await readForm(req);
            const name = readCampaignId(String(form.get('id') ?? ''));
            const targets = campaignTargets(name, readChannels(form));
            const draft = await readDraft(form);
            const group = targets.length > 1 ? name : undefined;
            const campaigns = [];
            for (const { id, channel } of targets) {
                campaigns.push({ id, channel, draft, rows: await previewDraft(store, settings(), id, channel, draft, group) });
            }
            store.importCampaigns(campaigns);
            changed();
            return json(res, 201, { id: targets[0]!.id, ids: targets.map(({ id }) => id) });
        }

        const match = /^\/api\/campaigns\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?$/.exec(pathname);
        if (!match?.[1]) throw new HttpError(404, 'This page does not exist.');
        const id = readCampaignId(match[1]);
        const action = match[2];

        if (!action && method === 'GET') {
            const requested = Number(searchParams.get('page') ?? '1');
            const page = Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
            const campaign = runner.decorate(store.campaignSummary(id));
            const draft = ['Draft', 'Ready'].includes(campaign.state) && !campaign.runActive
                ? store.getWebDraftSettings(id)
                : null;
            return json(res, 200, { campaign, ...store.listMessagePage(id, page, 25), draft });
        }
        if (action === 'export' && method === 'GET') {
            return workbookResponse(res, await exportCampaignWorkbook(store, id), `${id}-results.xlsx`);
        }
        if (action === 'draft' && method === 'PUT') {
            ensureIdle(id);
            const campaign = store.getCampaign(id);
            if (campaign.accountId || !['Draft', 'Ready'].includes(campaign.state)) {
                throw new HttpError(409, 'Only campaigns that have never started can be edited.');
            }
            const previous = store.getWebDraft(id);
            if (!previous) throw new HttpError(409, 'Only campaigns imported in the dashboard have editable drafts.');
            const draft = await readDraft(await readForm(req), previous.workbook);
            const rows = await previewDraft(store, settings(), id, campaign.channel, draft);
            ensureIdle(id);
            store.replaceWebDraft(id, rows, draft);
            changed();
            return json(res, 200, { id });
        }
        if (!action && method === 'DELETE') {
            ensureIdle(id);
            store.deleteCampaign(id);
            changed();
            res.writeHead(204).end();
            return;
        }
        if (method !== 'POST' || !action || !['start', 'resume', 'pause', 'cancel', 'retry', 'review'].includes(action)) {
            throw new HttpError(404, 'This action does not exist.');
        }
        const body = await readJson(req);
        switch (action) {
            case 'start':
            case 'resume':
                runner.launch(id, action, body.approve);
                return json(res, 202, { id });
            case 'pause':
                runner.pause(id);
                break;
            case 'cancel':
                runner.cancel(id);
                break;
            case 'retry':
                ensureIdle(id);
                if (!store.retryFailed(id)) throw new HttpError(409, 'There are no eligible failed recipients to retry.');
                break;
            case 'review': {
                const { recordId, outcome, note } = body;
                if (typeof recordId !== 'number' || !Number.isSafeInteger(recordId) || recordId < 1 ||
                    (outcome !== 'SENT' && outcome !== 'FAILED') || typeof note !== 'string' || !note.trim() || note.length > 1_000) {
                    throw new HttpError(400, 'Choose Sent or Failed and enter a review note of up to 1,000 characters.');
                }
                store.review(recordId, outcome, note.trim(), id);
                break;
            }
        }
        changed();
        return json(res, 200, { id });
    }

    function ensureIdle(id: string) {
        if (runner.isActive(id)) throw new HttpError(409, 'Wait for the campaign worker to finish stopping.');
    }

    const server = createServer({ requestTimeout: 30_000 }, (req, res) => {
        void route(req, res).catch(error => {
            const failure = publicError(error);
            if (failure.status === 500) console.error('Dashboard request failed', error);
            if (!res.headersSent) json(res, failure.status, { error: failure.message, ...(failure.field ? { field: failure.field } : {}) });
            else res.destroy();
        });
    });
    try {
        server.listen(requestedPort, '127.0.0.1');
        await once(server, 'listening');
        port = (server.address() as AddressInfo).port;
    } catch (error) {
        observer.close();
        db.close();
        throw error;
    }

    const progressTimer = setInterval(publishSafely, 500).unref();
    const heartbeat = setInterval(() => {
        for (const client of subscribers) writeEvent(client, ': keep-alive\n\n', false);
    }, 15_000).unref();

    let shutdown: Promise<void> | undefined;
    return {
        url: `http://127.0.0.1:${port}`,
        close() {
            return shutdown ??= (async () => {
                closing = true;
                clearInterval(progressTimer);
                clearInterval(heartbeat);
                for (const client of subscribers) client.end();
                const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                try {
                    await Promise.all([runner.close(), whatsapp.close(), stopped]);
                } finally {
                    observer.close();
                    db.close();
                }
            })();
        },
    };
}
