import { link, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import type { CampaignChannel } from '../types/index.js';
import { MAX_CAMPAIGN_ROWS } from '../config/constants.js';

const inputColumns = [
    ['Client ID', 'clientId', 16],
    ['Client Name', 'clientName', 25],
    ['Phone Number', 'phone', 22],
    ['Message', 'message', 54],
    ['PDF Filename', 'pdfFilename', 27],
    ['Consent Status', 'consentStatus', 20],
    ['Campaign ID', 'campaignId', 18],
] as const;
const gmailInputColumns = [
    inputColumns[0], inputColumns[1],
    ['Email Address', 'email', 34],
    ['Subject', 'subject', 40],
    ...inputColumns.slice(3),
] as const;

const trackingColumns = [
    ['Sending Status', 'sendingStatus', 19],
    ['WhatsApp Message ID', 'whatsappMessageId', 31],
    ['Sent At', 'sentAt', 23],
    ['Error Message', 'errorMessage', 48],
    ['Retry Count', 'retryCount', 16],
] as const;
const receiptColumns = [
    ['Server Acknowledged At', 'serverAcknowledgedAt', 25],
    ['Delivered At', 'deliveredAt', 23],
    ['Read At', 'readAt', 23],
] as const;

type InputField = (typeof inputColumns)[number][1];
type EmailFields = { email?: string; subject?: string };
export type ImportRow = Record<InputField, string> & EmailFields & { rowNumber: number; error?: string };

export interface ExportRow extends Record<InputField, string>, EmailFields {
    sendingStatus: string;
    whatsappMessageId?: string | null;
    gmailMessageId?: string | null;
    sentAt?: string | null;
    errorMessage?: string | null;
    retryCount: number;
    serverAcknowledgedAt?: string | null;
    deliveredAt?: string | null;
    readAt?: string | null;
}

function makeWorkbook(results: boolean, channel: CampaignChannel): { workbook: ExcelJS.Workbook; sheet: ExcelJS.Worksheet } {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(results ? 'Results' : 'Clients', { views: [{ state: 'frozen', ySplit: 1 }] });
    const gmail = channel === 'gmail';
    const receipts = results ? (gmail ? receiptColumns.slice(0, 1) : receiptColumns) : [];
    const columns = [
        ...(gmail ? gmailInputColumns : inputColumns),
        trackingColumns[0],
        gmail ? ['Gmail Message ID', 'gmailMessageId', 48] as const : trackingColumns[1],
        ...trackingColumns.slice(2),
        ...receipts,
    ];
    sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const header = sheet.getRow(1);
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF164E4B' } };
    header.alignment = { vertical: 'middle' };
    for (const key of ['clientId', gmail ? 'email' : 'phone', 'campaignId', gmail ? 'gmailMessageId' : 'whatsappMessageId']) {
        sheet.getColumn(key).numFmt = '@';
    }
    for (const key of ['message', 'errorMessage']) {
        sheet.getColumn(key).alignment = { vertical: 'top', wrapText: true };
    }
    for (const key of ['sentAt', ...receipts.map(([, key]) => key)]) {
        sheet.getColumn(key).numFmt = 'yyyy-mm-dd hh:mm:ss" UTC"';
    }
    return { workbook, sheet };
}

async function publishWorkbook(data: Buffer, path: string): Promise<boolean> {
    const target = resolve(path);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(parent, '.workbook-'));
    try {
        const file = join(temporary, 'workbook.xlsx');
        await writeFile(file, data, { flag: 'wx', mode: 0o600 });
        try {
            // Publish only after the workbook is complete. Another process may have created it first.
            await link(file, target);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw error;
        }
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

export async function generateExcel(path: string, channel: CampaignChannel = 'whatsapp'): Promise<boolean> {
    try {
        const existing = await lstat(path);
        if (!existing.isFile()) throw new Error('The Excel template path already exists and is not a regular file.');
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return publishWorkbook(await createExcelTemplate(channel), path);
}

/**
 * Blank import template for the dashboard: only the columns a user fills in, with no sample rows,
 * so every recipient, message and attachment comes from the user. `both` carries both address columns.
 */
async function createBlankTemplate(channel: CampaignChannel | 'both'): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clients', { views: [{ state: 'frozen', ySplit: 1 }] });
    const columns = channel === 'both'
        ? [...gmailInputColumns.slice(0, 3), inputColumns[2], ...gmailInputColumns.slice(3)]
        : channel === 'gmail' ? [...gmailInputColumns] : [...inputColumns];
    sheet.columns = columns.map(([header, key, width]) => ({ header: key === 'pdfFilename' ? 'Attachment' : header, key, width }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const header = sheet.getRow(1);
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F6F73' } };
    for (const [, key] of columns) {
        if (['clientId', 'email', 'phone', 'campaignId'].includes(key)) sheet.getColumn(key).numFmt = '@';
    }
    sheet.getColumn('message').alignment = { vertical: 'top', wrapText: true };
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function createExcelTemplate(channel: CampaignChannel | 'both', forWeb = false): Promise<Buffer> {
    if (forWeb || channel === 'both') return createBlankTemplate(channel);
    const { workbook, sheet } = makeWorkbook(false, channel);
    sheet.addRow({
        clientId: 'SAMPLE-001',
        clientName: 'Example Client',
        phone: '+12025550101',
        email: 'client@example.com',
        subject: 'Hello {{client_name}}',
        message: 'Dear {{client_name}}, …',
        consentStatus: 'Not Opted In',
        campaignId: 'sample',
        sendingStatus: 'Pending',
        retryCount: 0,
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

function readInputValue(cell: ExcelJS.Cell, field: InputField | keyof EmailFields): string {
    const value = cell.value;
    if (value === null) return '';
    if (cell.type === ExcelJS.ValueType.Merge) throw new Error('Merged cells cannot be imported');
    if (typeof value === 'string') return field === 'message' ? value : value.trim();
    if (field === 'email' && typeof value === 'object' && 'hyperlink' in value &&
        value.hyperlink.toLowerCase() === `mailto:${value.text.trim().toLowerCase()}`) {
        return value.text.trim();
    }
    if (typeof value === 'number' && ['phone', 'clientId', 'campaignId'].includes(field) &&
        Number.isSafeInteger(value) && value >= 0 && value < 1e15) {
        return String(value);
    }
    if (typeof value === 'object' && 'richText' in value) {
        const plain = value.richText.map(({ text }) => text).join('');
        return field === 'message' ? plain : plain.trim();
    }
    throw new Error('Enter a text value without formulas or hyperlinks');
}

export async function readExcel(source: string | Buffer, channel: CampaignChannel = 'whatsapp'): Promise<ImportRow[]> {
    const workbook = new ExcelJS.Workbook();
    if (typeof source === 'string') {
        await workbook.xlsx.readFile(source);
    } else {
        await workbook.xlsx.load(Uint8Array.from(source).buffer);
    }
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) throw new Error('The workbook has no worksheets.');

    const headerPositions = new Map<string, number>();
    const inputs = channel === 'gmail' ? gmailInputColumns : inputColumns;
    const expected = new Set<string>(inputs.map(([name]) => name.toLowerCase()));
    sheet.getRow(1).eachCell((cell, column) => {
        if (typeof cell.value !== 'string') return;
        const raw = cell.value.trim().toLowerCase();
        // Dashboard templates call the attachment column "Attachment"; older workbooks use "PDF Filename".
        const header = raw === 'attachment' ? 'pdf filename' : raw;
        if (!expected.has(header)) return;
        if (headerPositions.has(header)) throw new Error(`Duplicate Excel column header: ${cell.value.trim()}.`);
        headerPositions.set(header, column);
    });

    const columns = inputs.map(([header, field]) => {
        const column = headerPositions.get(header.toLowerCase());
        if (column === undefined) throw new Error(`Missing Excel column header: ${header}.`);
        return { header, field, column };
    });

    const records: ImportRow[] = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const record: ImportRow = {
            rowNumber,
            clientId: '',
            clientName: '',
            phone: '',
            message: '',
            pdfFilename: '',
            consentStatus: '',
            campaignId: '',
        };
        for (const { header, field, column } of columns) {
            try {
                record[field] = readInputValue(row.getCell(column), field);
            } catch (error) {
                record.error ??= `${header}: ${(error as Error).message}.`;
            }
        }
        if (record.error !== undefined || columns.some(({ field }) => record[field]?.trim())) {
            if (records.length === MAX_CAMPAIGN_ROWS) {
                throw new Error(`A workbook can contain at most ${MAX_CAMPAIGN_ROWS} contact rows.`);
            }
            records.push(record);
        }
    });
    return records;
}

function excelDate(timestamp: string | null | undefined): Date | null {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date : null;
}

export async function writeExcel(path: string, rows: readonly ExportRow[], channel: CampaignChannel = 'whatsapp'): Promise<void> {
    if (!await publishWorkbook(await createResultsWorkbook(rows, channel), path)) {
        throw new Error('The export file already exists. Choose a new path.');
    }
}

export async function createResultsWorkbook(rows: readonly ExportRow[], channel: CampaignChannel): Promise<Buffer> {
    const { workbook, sheet } = makeWorkbook(true, channel);
    for (const row of rows) {
        sheet.addRow({
            ...row,
            sentAt: excelDate(row.sentAt),
            serverAcknowledgedAt: excelDate(row.serverAcknowledgedAt),
            deliveredAt: excelDate(row.deliveredAt),
            readAt: excelDate(row.readAt),
        });
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}
