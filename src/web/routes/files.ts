import { generateDraft } from '../../services/ai.service.js';
import { readAttachment } from '../../services/attachment.service.js';
import { createExcelTemplate } from '../../services/excel/template.js';
import type { CampaignChannel } from '../../types/index.js';
import { HttpError } from '../http-error.js';
import { json, sendAttachment, sendWorkbook } from '../http.js';
import { listAttachments, readChannel, readDraftRequest, readForm, readJson, storeAttachment } from '../input/index.js';
import type { App, Request, Route } from './route.js';

const AI_REQUEST_LIMIT = 64 * 1024;

export const fileRoutes: Route[] = [
    { method: 'GET', path: '/api/template', handle: downloadTemplate },
    { method: 'GET', path: '/api/attachments', handle: async ({ res }, app) => json(res, 200, { files: await listAttachments(app.env.ATTACHMENTS_DIR) }) },
    { method: 'GET', path: /^\/api\/attachments\/([^/]+)$/u, handle: showAttachment },
    { method: 'POST', path: '/api/attachments', handle: uploadAttachment },
    { method: 'POST', path: '/api/drafts/generate', handle: writeWithAi },
];

async function downloadTemplate({ res, query }: Request, app: App): Promise<void> {
    const requested = query.get('channel') ?? 'gmail';
    const channel = requested === 'both' ? requested : readChannel(requested);
    sendWorkbook(res, await cachedTemplate(app, channel), `message-blaster-${channel}-sample.xlsx`);
}

function cachedTemplate(app: App, channel: CampaignChannel | 'both'): Promise<Buffer> {
    const cached = app.templates.get(channel);
    if (cached) return cached;
    const template = createExcelTemplate(channel, true).catch(error => {
        app.templates.delete(channel);
        throw error;
    });
    app.templates.set(channel, template);
    return template;
}

async function showAttachment({ res, params, query }: Request, app: App): Promise<void> {
    const name = decodeName(params[0]!);
    const file = await readAttachment(app.env.ATTACHMENTS_DIR, name).catch((error: unknown) => {
        throw new HttpError(404, error instanceof Error ? error.message : 'Attachment was not found.');
    });
    sendAttachment(res, file.name, file.data, query.has('download'));
}

async function uploadAttachment({ req, res }: Request, app: App): Promise<void> {
    const name = await storeAttachment(app.env.ATTACHMENTS_DIR, await readForm(req));
    json(res, 201, { name });
}

async function writeWithAi({ req, res }: Request, app: App): Promise<void> {
    const request = readDraftRequest(await readJson(req, AI_REQUEST_LIMIT));
    json(res, 200, await generateDraft(app.env, request));
}

function decodeName(encoded: string): string {
    try {
        return decodeURIComponent(encoded);
    } catch {
        throw new HttpError(400, 'Invalid attachment name.');
    }
}
