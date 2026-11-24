import type { Environment } from '../../config/env.js';
import { MAX_SCRIPT_HTML_LENGTH } from '../../config/constants.js';
import { AttachmentError, readAttachment } from '../../services/attachment.service.js';
import { prepareRows } from '../../services/campaign/prepare-rows.js';
import type { ImportRow } from '../../services/excel/columns.js';
import { readExcelChannels } from '../../services/excel/read.js';
import { createRecipientsWorkbook } from '../../services/excel/template.js';
import { cleanScriptHtml, scriptText } from '../../services/rich-script.js';
import type { DraftField, PreparedRow, SharedContent, Store } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { HttpError } from '../http-error.js';
import { readFile, readText } from './fields.js';
import { readTypedRecipients } from './recipients.js';

interface Message {
    script: string;
    scriptHtml?: string;
}

export interface Draft extends Message {
    workbook: Buffer;
    source: 'recipients' | 'workbook';
    subject: string;
    attachment: string;
}

export interface ChannelDraft extends Draft {
    overrides: DraftField[];
}

export interface CampaignTarget {
    id: string;
    channel: CampaignChannel;
}

export interface PreparedCampaign extends CampaignTarget {
    draft: ChannelDraft;
    rows: PreparedRow[];
}

const WORKBOOK_PROBLEMS = /^(Missing Excel|Duplicate Excel|A workbook can contain|The workbook has no)/u;

export async function readDraft(form: FormData, previousWorkbook?: Buffer): Promise<Draft> {
    return {
        ...await readRecipientSource(form, previousWorkbook),
        ...readMessage(form, ''),
        subject: readText(form, 'subject', 255, 'subject').trim(),
        attachment: readText(form, 'attachment', 255, 'attachment').trim(),
    };
}

export function sharedContent({ script, scriptHtml, subject, attachment }: Draft): SharedContent {
    return { script, subject, attachment, ...(scriptHtml ? { scriptHtml } : {}) };
}

export function channelDrafts(form: FormData, shared: Draft, channels: readonly CampaignChannel[], combined: boolean): ChannelDraft[] {
    return channels.map(channel => (combined ? channelDraft(form, shared, channel) : { ...shared, overrides: [] }));
}

export async function prepareCampaigns(store: Store, env: Environment, targets: readonly CampaignTarget[], drafts: readonly ChannelDraft[],
    group?: string): Promise<PreparedCampaign[]> {
    const parsed = await parseWorkbook(env, targets.map(target => target.channel), drafts);
    const prepared: PreparedCampaign[] = [];
    for (const [index, target] of targets.entries()) {
        const draft = drafts[index]!;
        const rows = selectRows(parsed.get(target.channel) ?? [], target, draft, group);
        prepared.push({ ...target, draft, rows: await prepareRows(store, env, target.id, rows, draft.script, target.channel, draft.scriptHtml) });
    }
    return prepared;
}

function channelDraft(form: FormData, shared: Draft, channel: CampaignChannel): ChannelDraft {
    const prefix = `${channel}.`;
    const message = form.has(`${prefix}script`) || form.has(`${prefix}scriptHtml`) ? readMessage(form, prefix) : undefined;
    const subject = channel === 'gmail' && form.has('gmail.subject') ? readText(form, 'gmail.subject', 255, 'subject').trim() : undefined;
    const attachment = form.has(`${prefix}attachment`) ? readText(form, `${prefix}attachment`, 255, 'attachment').trim() : undefined;
    const { scriptHtml: _sharedHtml, ...withoutHtml } = shared;
    return {
        ...(message ? { ...withoutHtml, ...message } : shared),
        subject: channel === 'gmail' ? subject ?? shared.subject : '',
        attachment: attachment ?? shared.attachment,
        overrides: [
            ...(message ? ['message' as const] : []),
            ...(subject === undefined ? [] : ['subject' as const]),
            ...(attachment === undefined ? [] : ['attachment' as const]),
        ],
    };
}

async function readRecipientSource(form: FormData, previousWorkbook?: Buffer): Promise<Pick<Draft, 'workbook' | 'source'>> {
    const typed = readTypedRecipients(form);
    if (typed.length) return { workbook: await createRecipientsWorkbook(typed), source: 'recipients' };
    const upload = readFile(form, 'workbook', '.xlsx', 'workbook');
    const workbook = upload ? Buffer.from(await upload.arrayBuffer()) : previousWorkbook;
    if (!workbook) throw new HttpError(400, 'Choose an Excel .xlsx workbook.', 'workbook');
    return { workbook, source: 'workbook' };
}

function readMessage(form: FormData, prefix: string): Message {
    const html = cleanScriptHtml(readText(form, `${prefix}scriptHtml`, MAX_SCRIPT_HTML_LENGTH, 'script'));
    const plain = html ? scriptText(html) : '';
    if (plain) return { script: plain, scriptHtml: html };
    return { script: readText(form, `${prefix}script`, 32_767, 'script') };
}

async function parseWorkbook(env: Environment, channels: readonly CampaignChannel[], drafts: readonly Draft[]): Promise<Map<CampaignChannel, ImportRow[]>> {
    try {
        const parsed = await readExcelChannels(drafts[0]!.workbook, channels);
        for (const name of new Set(drafts.map(draft => draft.attachment).filter(Boolean))) await readAttachment(env.ATTACHMENTS_DIR, name);
        return parsed;
    } catch (error) {
        if (error instanceof AttachmentError) throw new HttpError(400, error.message, 'attachment');
        if (error instanceof Error && WORKBOOK_PROBLEMS.test(error.message)) throw new HttpError(400, error.message, 'workbook');
        throw new HttpError(400, 'Could not read the workbook. Use the downloadable Excel sample.', 'workbook');
    }
}

function selectRows(rows: ImportRow[], { id, channel }: CampaignTarget, draft: Draft, group?: string): ImportRow[] {
    const matching = rows.filter(row => !row.campaignId || row.campaignId === id || row.campaignId === group);
    const selected = group ? matching.filter(row => (channel === 'gmail' ? row.email : row.phone)?.trim()) : matching;
    if (!selected.length) throw new HttpError(400, noRowsMessage(channel, group), draft.source);
    return selected.map(row => withDefaults(row, draft, channel));
}

function withDefaults(row: ImportRow, draft: Draft, channel: CampaignChannel): ImportRow {
    const subject = channel === 'gmail' && !row.subject ? { subject: draft.subject } : {};
    return { ...row, ...subject, pdfFilename: row.pdfFilename || draft.attachment };
}

function noRowsMessage(channel: CampaignChannel, group?: string): string {
    if (!group) return 'No rows match this campaign. Check the workbook’s Campaign ID column.';
    return channel === 'gmail' ? 'No rows have an email address for Gmail.' : 'No rows have a phone number for WhatsApp.';
}
