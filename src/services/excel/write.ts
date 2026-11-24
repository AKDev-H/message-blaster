import type { CampaignChannel } from '../../types/index.js';
import type { ExportRow } from './columns.js';
import { trackingSheet } from './template.js';
import { publishWorkbook } from './publish.js';
import { toBuffer } from './sheet.js';

export async function writeExcel(path: string, rows: readonly ExportRow[], channel: CampaignChannel = 'whatsapp'): Promise<void> {
    const created = await publishWorkbook(await createResultsWorkbook(rows, channel), path);
    if (!created) throw new Error('The export file already exists. Choose a new path.');
}

export async function createResultsWorkbook(rows: readonly ExportRow[], channel: CampaignChannel): Promise<Buffer> {
    const { workbook, sheet } = trackingSheet(channel, true);
    for (const row of rows) sheet.addRow(withExcelDates(row));
    return toBuffer(workbook);
}

function withExcelDates(row: ExportRow) {
    return {
        ...row,
        sentAt: excelDate(row.sentAt),
        serverAcknowledgedAt: excelDate(row.serverAcknowledgedAt),
        deliveredAt: excelDate(row.deliveredAt),
        readAt: excelDate(row.readAt),
    };
}

function excelDate(timestamp: string | null | undefined): Date | null {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date : null;
}
