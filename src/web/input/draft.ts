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

export type Draft = Awaited<ReturnType<typeof readDraft>>;
export type ChannelDraft = Draft & { overrides: DraftField[] };
export type ParsedWorkbook = Map<CampaignChannel, ImportRow[]>;

const WORKBOOK_PROBLEMS = /^(Missing Excel|Duplicate Excel|A workbook can contain|The workbook has no)/u;

export async function readDraft(form: FormData, previousWorkbook?: Buffer) {
    return {
        ...await readRecipientSource(form, previousWorkbook),
        ...readScript(form),
        subject: readText(form, 'subject', 255, 'subject').trim(),
        attachment: readText(form, 'attachment', 255, 'attachment').trim(),
    };
}

export function channelDraft(form: FormData, draft: Draft, channel: CampaignChannel): ChannelDraft {
    const overrides: DraftField[] = [];
    const content: ChannelDraft = { ...draft, overrides };
    if (form.has(`${channel}.script`) || form.has(`${channel}.scriptHtml`)) {
        const { script, scriptHtml } = readScript(form, `${channel}.`);
        Object.assign(content, { script, scriptHtml });
        if (scriptHtml === undefined) delete content.scriptHtml;
        overrides.push('message');
    }
    if (channel === 'gmail' && form.has('gmail.subject')) {
        content.subject = readText(form, 'gmail.subject', 255, 'subject').trim();
        overrides.push('subject');
    }
    if (channel !== 'gmail') content.subject = '';
    if (form.has(`${channel}.attachment`)) {
        content.attachment = readText(form, `${channel}.attachment`, 255, 'attachment').trim();
        overrides.push('attachment');
    }
    return content;
}

export function sharedContent(draft: Draft): SharedContent {
    return { script: draft.script, subject: draft.subject, attachment: draft.attachment, ...(draft.scriptHtml ? { scriptHtml: draft.scriptHtml } : {}) };
}

export async function parseWorkbook(env: Environment, channels: readonly CampaignChannel[], drafts: readonly Draft[]): Promise<ParsedWorkbook> {
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

export async function prepareChannel(store: Store, env: Environment, id: string, channel: CampaignChannel, draft: Draft,
    parsed: ParsedWorkbook, group?: string): Promise<PreparedRow[]> {
    const selected = rowsForCampaign(parsed.get(channel) ?? [], id, channel, group);
    if (!selected.length) throw new HttpError(400, noRowsMessage(channel, group), draft.source);
    for (const row of selected) applyDraftDefaults(row, draft, channel);
    return prepareRows(store, env, id, selected, draft.script, channel, draft.scriptHtml);
}

export async function previewDraft(store: Store, env: Environment, id: string, channel: CampaignChannel, draft: Draft,
    group?: string): Promise<PreparedRow[]> {
    return prepareChannel(store, env, id, channel, draft, await parseWorkbook(env, [channel], [draft]), group);
}

async function readRecipientSource(form: FormData, previousWorkbook?: Buffer) {
    const typed = readTypedRecipients(form);
    if (typed.length) return { workbook: await createRecipientsWorkbook(typed), source: 'recipients' as const };
    const upload = readFile(form, 'workbook', '.xlsx', 'workbook');
    const workbook = upload ? Buffer.from(await upload.arrayBuffer()) : previousWorkbook;
    if (!workbook) throw new HttpError(400, 'Choose an Excel .xlsx workbook.', 'workbook');
    return { workbook, source: 'workbook' as const };
}

function readScript(form: FormData, prefix = ''): { script: string; scriptHtml?: string } {
    const html = cleanScriptHtml(readText(form, `${prefix}scriptHtml`, MAX_SCRIPT_HTML_LENGTH, 'script'));
    const plain = html ? scriptText(html) : '';
    if (plain) return { script: plain, scriptHtml: html };
    return { script: readText(form, `${prefix}script`, 32_767, 'script') };
}

function rowsForCampaign(rows: ImportRow[], id: string, channel: CampaignChannel, group?: string): ImportRow[] {
    const matches = rows.filter(row => !row.campaignId || row.campaignId === id || row.campaignId === group);
    return group ? matches.filter(row => (channel === 'gmail' ? row.email : row.phone)?.trim()) : matches;
}

function noRowsMessage(channel: CampaignChannel, group?: string): string {
    if (!group) return 'No rows match this campaign. Check the workbook’s Campaign ID column.';
    return channel === 'gmail' ? 'No rows have an email address for Gmail.' : 'No rows have a phone number for WhatsApp.';
}

function applyDraftDefaults(row: ImportRow, draft: Draft, channel: CampaignChannel): void {
    if (!row.pdfFilename) row.pdfFilename = draft.attachment;
    if (!row.subject && channel === 'gmail') row.subject = draft.subject;
}
