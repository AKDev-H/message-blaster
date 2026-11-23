import { link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Environment } from '../config/env.js';
import { CAMPAIGN_ID, MAX_SCRIPT_HTML_LENGTH } from '../config/constants.js';
import type { DraftRequest } from '../services/ai.service.js';
import { isSupportedCountry } from 'libphonenumber-js';
import { AttachmentError, isAllowedAttachmentName, readAttachment } from '../services/attachment.service.js';
import { prepareRows } from '../services/campaign.service.js';
import { readExcel } from '../services/excel.service.js';
import type { Store } from '../services/message.service.js';
import type { EditableSettings } from '../services/settings.service.js';
import { cleanScriptHtml, scriptText } from '../services/rich-script.js';
import type { CampaignChannel } from '../types/index.js';
import { normalizeEmail } from '../utils/email.util.js';

const maxFileBytes = 10 * 1024 * 1024;
const maxMultipartBytes = maxFileBytes + 256 * 1024;

/** Form fields the dashboard can highlight when a request is rejected. */
export type DraftField = 'id' | 'channel' | 'workbook' | 'subject' | 'script' | 'attachment'
    | 'gmailUser' | 'gmailPassword' | 'country' | 'delay';

export class HttpError extends Error {
    constructor(readonly status: number, message: string, readonly field?: DraftField) {
        super(message);
    }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    const rejectSize = () => {
        req.resume();
        return new HttpError(413, 'The upload is too large.');
    };
    if (Number(req.headers['content-length']) > limit) throw rejectSize();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > limit) throw rejectSize();
        chunks.push(chunk);
    }
    return Uint8Array.from(Buffer.concat(chunks, size));
}

export async function readForm(req: IncomingMessage): Promise<FormData> {
    const type = req.headers['content-type'];
    if (!type?.startsWith('multipart/form-data;')) throw new HttpError(415, 'Upload the file using a multipart form.');
    const body = await readBody(req, maxMultipartBytes);
    try {
        return await new Response(body, { headers: { 'content-type': type } }).formData();
    } catch {
        throw new HttpError(400, 'The upload form could not be read.');
    }
}

export async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        throw new HttpError(415, 'Send a JSON request.');
    }
    const body = await readBody(req, limit);
    try {
        const result: unknown = JSON.parse(new TextDecoder().decode(body));
        if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
    } catch {
        throw new HttpError(400, 'The request contains invalid JSON.');
    }
    throw new HttpError(400, 'The request must contain a JSON object.');
}

export function readChannel(value: unknown): CampaignChannel {
    if (value === 'gmail' || value === 'whatsapp') return value;
    throw new HttpError(400, 'Choose Gmail or WhatsApp.', 'channel');
}

/** Reads the ticked delivery channels; a campaign can go out over Gmail, WhatsApp, or both. */
export function readChannels(form: FormData): CampaignChannel[] {
    const channels = [...new Set(form.getAll('channel'))].map(readChannel);
    if (!channels.length) throw new HttpError(400, 'Choose at least one channel.', 'channel');
    return channels;
}

/** Reads the Gmail sender. A blank password keeps the saved one, so it never has to be sent back to the browser. */
export function readGmailSettings(body: Record<string, unknown>, hasPassword: boolean): Partial<EditableSettings> {
    const { user, password } = body;
    let address: string;
    try {
        address = normalizeEmail(typeof user === 'string' ? user : '');
    } catch {
        throw new HttpError(400, 'Enter the Gmail address you send from.', 'gmailUser');
    }
    const pass = typeof password === 'string' ? password.replaceAll(/\s/gu, '') : '';
    if (!pass && !hasPassword) throw new HttpError(400, 'Enter the 16-character App Password.', 'gmailPassword');
    if (pass && !/^[a-z0-9]{16}$/iu.test(pass)) {
        throw new HttpError(400, 'An App Password has 16 letters and numbers.', 'gmailPassword');
    }
    return { GMAIL_USER: address, ...(pass ? { GMAIL_APP_PASSWORD: pass } : {}) };
}

/** Reads sending preferences: the country for local phone numbers and the pause between messages. */
export function readSendingSettings(body: Record<string, unknown>): Partial<EditableSettings> {
    const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
    if (!isSupportedCountry(country)) throw new HttpError(400, 'Choose a country.', 'country');
    const seconds = body.delaySeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) {
        throw new HttpError(400, 'Use 0–3,600 seconds.', 'delay');
    }
    return { DEFAULT_COUNTRY: country, MESSAGE_DELAY_MS: Math.round(seconds * 1_000) };
}

/** Reads an AI drafting request: what to write, for which channels, and optionally the draft to revise. */
export function readDraftRequest(body: Record<string, unknown>): DraftRequest {
    const { prompt, channels, subject, message } = body;
    if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 1_000) {
        throw new HttpError(400, 'Describe the message in 3–1,000 characters.');
    }
    if (!Array.isArray(channels) || !channels.length) throw new HttpError(400, 'Choose at least one channel.', 'channel');
    const optional = (value: unknown, limit: number) => (typeof value === 'string' && value.trim() ? value.slice(0, limit) : undefined);
    return {
        prompt: prompt.trim(),
        channels: [...new Set(channels.map(readChannel))],
        ...(optional(subject, 255) ? { subject: optional(subject, 255)! } : {}),
        ...(optional(message, 8_000) ? { message: optional(message, 8_000)! } : {}),
    };
}

/** One campaign per channel. Sending to both channels suffixes each campaign name with its channel. */
export function campaignTargets(name: string, channels: readonly CampaignChannel[]) {
    if (channels.length === 1) return [{ id: name, channel: channels[0]! }];
    const targets = channels.map(channel => ({ id: `${name}-${channel}`, channel }));
    if (targets.some(({ id }) => !CAMPAIGN_ID.test(id))) {
        throw new HttpError(400, 'Use 55 characters or fewer when sending to both channels.', 'id');
    }
    return targets;
}

export function readCampaignId(value: string) {
    if (!CAMPAIGN_ID.test(value)) {
        throw new HttpError(400, 'Use 1–64 letters, numbers, hyphens, or underscores. Start with a letter or number.', 'id');
    }
    return value;
}

function text(form: FormData, name: string, limit: number, field?: DraftField): string {
    const value = form.get(name);
    if (value === null) return '';
    if (typeof value !== 'string' || value.length > limit) {
        throw new HttpError(400, `Use ${limit.toLocaleString('en-US')} characters or fewer.`, field);
    }
    return value;
}

function file(form: FormData, name: string, extension: string, field?: DraftField): File | undefined {
    const value = form.get(name);
    if (value === null || (typeof value !== 'string' && !value.name && !value.size)) return;
    if (typeof value === 'string' || !value.size || !value.name.toLowerCase().endsWith(extension)) {
        throw new HttpError(400, `Choose a ${extension} file.`, field);
    }
    if (value.size > maxFileBytes) throw new HttpError(413, 'Each upload can be up to 10 MB.', field);
    return value;
}

/** Reads the formatted script, keeping only safe formatting and deriving the plain-text fallback from it. */
function readScript(form: FormData) {
    const html = cleanScriptHtml(text(form, 'scriptHtml', MAX_SCRIPT_HTML_LENGTH, 'script'));
    const plain = html ? scriptText(html) : '';
    if (plain) return { script: plain, scriptHtml: html };
    return { script: text(form, 'script', 32_767, 'script') };
}

export async function readDraft(form: FormData, previousWorkbook?: Buffer) {
    const upload = file(form, 'workbook', '.xlsx', 'workbook');
    const workbook = upload ? Buffer.from(await upload.arrayBuffer()) : previousWorkbook;
    if (!workbook) throw new HttpError(400, 'Choose an Excel .xlsx workbook.', 'workbook');
    return {
        workbook,
        ...readScript(form),
        subject: text(form, 'subject', 255, 'subject').trim(),
        attachment: text(form, 'attachment', 255, 'attachment').trim(),
    };
}

export async function previewDraft(
    store: Store,
    env: Environment,
    id: string,
    channel: CampaignChannel,
    draft: Awaited<ReturnType<typeof readDraft>>,
    group?: string,
) {
    let rows;
    try {
        rows = await readExcel(draft.workbook, channel);
        if (draft.attachment) await readAttachment(env.ATTACHMENTS_DIR, draft.attachment);
    } catch (error) {
        if (error instanceof AttachmentError) throw new HttpError(400, error.message, 'attachment');
        if (error instanceof Error && /^(Missing Excel|Duplicate Excel|A workbook can contain|The workbook has no)/u.test(error.message)) {
            throw new HttpError(400, error.message, 'workbook');
        }
        throw new HttpError(400, 'Could not read the workbook. Use the downloadable Excel sample.', 'workbook');
    }
    const matches = rows.filter(row => !row.campaignId || row.campaignId === id || row.campaignId === group);
    // In a multi-channel send, a row without an address for this channel belongs only to the other channel.
    const selected = group ? matches.filter(row => (channel === 'gmail' ? row.email : row.phone)?.trim()) : matches;
    if (!selected.length) {
        const message = group
            ? `No rows have ${channel === 'gmail' ? 'an email address' : 'a phone number'} for ${channel === 'gmail' ? 'Gmail' : 'WhatsApp'}.`
            : 'No rows match this campaign. Check the workbook’s Campaign ID column.';
        throw new HttpError(400, message, 'workbook');
    }
    for (const row of selected) {
        if (!row.pdfFilename) row.pdfFilename = draft.attachment;
        if (!row.subject && channel === 'gmail') row.subject = draft.subject;
    }
    return prepareRows(store, env, id, selected, draft.script, channel, draft.scriptHtml);
}

export async function listAttachments(directory: string) {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const names = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && isAllowedAttachmentName(entry.name))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
        const files = [];
        for (const name of names) {
            const info = await stat(join(directory, name)).catch(() => undefined);
            if (info?.isFile()) files.push({ name, size: info.size });
        }
        return files;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

export async function storeAttachment(directory: string, form: FormData): Promise<string> {
    const upload = form.get('file');
    if (!upload || typeof upload === 'string' || !upload.size) throw new HttpError(400, 'Choose a file to upload.');
    if (upload.size > maxFileBytes) throw new HttpError(413, 'Each upload can be up to 10 MB.');
    const { name } = upload;
    if (!isAllowedAttachmentName(name)) {
        throw new HttpError(400, 'This file type can’t be sent. Choose a document, image, or other common file.');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, '.upload-'));
    try {
        const source = join(temporary, name);
        await writeFile(source, Buffer.from(await upload.arrayBuffer()), { flag: 'wx', mode: 0o600 });
        await readAttachment(temporary, name);
        await link(source, join(directory, name));
        return name;
    } catch (error) {
        if (error instanceof AttachmentError) throw new HttpError(400, error.message);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new HttpError(409, 'A file already uses that name. Rename the upload to keep both versions.');
        }
        throw error;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
