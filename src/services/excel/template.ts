import { lstat } from 'node:fs/promises';
import type { CampaignChannel } from '../../types/index.js';
import { hasErrorCode } from '../../utils/fs.util.js';
import { blankTemplateColumns, receiptColumnsFor, trackingColumnsFor } from './columns.js';
import { createSheet, formatAsText, formatAsTimestamp, toBuffer, wrapText, type Sheet } from './sheet.js';
import { publishWorkbook } from './publish.js';

export interface TypedRecipient {
    clientName: string;
    email: string;
    phone: string;
}

const EXAMPLE_ROW = {
    clientName: 'Example Client',
    phone: '+12025550101',
    email: 'client@example.com',
    subject: 'Hello {{client_name}}',
    message: 'Dear {{client_name}}, …',
    consentStatus: 'Not Opted In',
    campaignId: 'sample',
    sendingStatus: 'Pending',
    retryCount: 0,
};

export async function generateExcel(path: string, channel: CampaignChannel = 'whatsapp'): Promise<boolean> {
    if (await existingWorkbook(path)) return false;
    return publishWorkbook(await createExcelTemplate(channel), path);
}

export async function createExcelTemplate(channel: CampaignChannel | 'both', forWeb = false): Promise<Buffer> {
    if (forWeb || channel === 'both') return blankTemplate(channel);
    const { workbook, sheet } = trackingSheet(channel, false);
    sheet.addRow(EXAMPLE_ROW);
    return toBuffer(workbook);
}

export function createRecipientsWorkbook(recipients: readonly TypedRecipient[]): Promise<Buffer> {
    return blankTemplate('both', recipients);
}

export function trackingSheet(channel: CampaignChannel, results: boolean): Sheet {
    const gmail = channel === 'gmail';
    const created = createSheet(results ? 'Results' : 'Clients', trackingColumnsFor(channel, results), 'FF164E4B');
    created.sheet.getRow(1).alignment = { vertical: 'middle' };
    formatAsText(created.sheet, [gmail ? 'email' : 'phone', 'campaignId', gmail ? 'gmailMessageId' : 'whatsappMessageId']);
    wrapText(created.sheet, ['message', 'errorMessage']);
    formatAsTimestamp(created.sheet, ['sentAt', ...receiptColumnsFor(channel, results).map(([, key]) => key)]);
    return created;
}

async function blankTemplate(channel: CampaignChannel | 'both', recipients: readonly TypedRecipient[] = []): Promise<Buffer> {
    const columns = blankTemplateColumns(channel).map(([header, key, width]) => [key === 'pdfFilename' ? 'Attachment' : header, key, width] as const);
    const { workbook, sheet } = createSheet('Clients', columns, 'FF2F6F73');
    formatAsText(sheet, columns.map(([, key]) => key).filter(key => ['email', 'phone', 'campaignId'].includes(key)));
    wrapText(sheet, ['message']);
    for (const recipient of recipients) sheet.addRow({ ...recipient, consentStatus: 'Opted In' });
    return toBuffer(workbook);
}

async function existingWorkbook(path: string): Promise<boolean> {
    try {
        if (!(await lstat(path)).isFile()) throw new Error('The Excel template path already exists and is not a regular file.');
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        throw error;
    }
}
