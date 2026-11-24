import type { Environment } from '../../config/env.js';
import { MAX_SCRIPT_HTML_LENGTH } from '../../config/constants.js';
import { AttachmentError, readAttachment } from '../../services/attachment.service.js';
import { prepareRows } from '../../services/campaign/prepare-rows.js';
import type { ImportRow } from '../../services/excel/columns.js';
import { readExcel } from '../../services/excel/read.js';
import { createRecipientsWorkbook } from '../../services/excel/template.js';
import { cleanScriptHtml, scriptText } from '../../services/rich-script.js';
import type { PreparedRow, Store } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { HttpError } from '../http-error.js';
import { readFile, readText } from './fields.js';
import { readTypedRecipients } from './recipients.js';

export type Draft = Awaited<ReturnType<typeof readDraft>>;

const WORKBOOK_PROBLEMS = /^(Missing Excel|Duplicate Excel|A workbook can contain|The workbook has no)/u;

export async function readDraft(form: FormData, previousWorkbook?: Buffer) {
    return {
        ...await readRecipientSource(form, previousWorkbook),
        ...readScript(form),
        subject: readText(form, 'subject', 255, 'subject').trim(),
        attachment: readText(form, 'attachment', 255, 'attachment').trim(),
    };
}

export async function previewDraft(store: Store, env: Environment, id: string, channel: CampaignChannel, draft: Draft,
    group?: string): Promise<PreparedRow[]> {
    const rows = await readDraftRows(env, channel, draft);
    const selected = rowsForCampaign(rows, id, channel, group);
    if (!selected.length) throw new HttpError(400, noRowsMessage(channel, group), draft.source);
    for (const row of selected) applyDraftDefaults(row, draft, channel);
    return prepareRows(store, env, id, selected, draft.script, channel, draft.scriptHtml);
}

async function readRecipientSource(form: FormData, previousWorkbook?: Buffer) {
    const typed = readTypedRecipients(form);
    if (typed.length) return { workbook: await createRecipientsWorkbook(typed), source: 'recipients' as const };
    const upload = readFile(form, 'workbook', '.xlsx', 'workbook');
    const workbook = upload ? Buffer.from(await upload.arrayBuffer()) : previousWorkbook;
    if (!workbook) throw new HttpError(400, 'Choose an Excel .xlsx workbook.', 'workbook');
    return { workbook, source: 'workbook' as const };
}

function readScript(form: FormData) {
    const html = cleanScriptHtml(readText(form, 'scriptHtml', MAX_SCRIPT_HTML_LENGTH, 'script'));
    const plain = html ? scriptText(html) : '';
    if (plain) return { script: plain, scriptHtml: html };
    return { script: readText(form, 'script', 32_767, 'script') };
}

async function readDraftRows(env: Environment, channel: CampaignChannel, draft: Draft): Promise<ImportRow[]> {
    try {
        const rows = await readExcel(draft.workbook, channel);
        if (draft.attachment) await readAttachment(env.ATTACHMENTS_DIR, draft.attachment);
        return rows;
    } catch (error) {
        if (error instanceof AttachmentError) throw new HttpError(400, error.message, 'attachment');
        if (error instanceof Error && WORKBOOK_PROBLEMS.test(error.message)) throw new HttpError(400, error.message, 'workbook');
        throw new HttpError(400, 'Could not read the workbook. Use the downloadable Excel sample.', 'workbook');
    }
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
