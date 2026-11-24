import ExcelJS from 'exceljs';
import type { Column } from './columns.js';

export interface Sheet {
    workbook: ExcelJS.Workbook;
    sheet: ExcelJS.Worksheet;
}

export function createSheet(name: string, columns: readonly Column[], headerColor: string): Sheet {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    styleHeader(sheet.getRow(1), headerColor);
    return { workbook, sheet };
}

export function formatAsText(sheet: ExcelJS.Worksheet, keys: readonly string[]): void {
    for (const key of keys) sheet.getColumn(key).numFmt = '@';
}

export function wrapText(sheet: ExcelJS.Worksheet, keys: readonly string[]): void {
    for (const key of keys) sheet.getColumn(key).alignment = { vertical: 'top', wrapText: true };
}

export function formatAsTimestamp(sheet: ExcelJS.Worksheet, keys: readonly string[]): void {
    for (const key of keys) sheet.getColumn(key).numFmt = 'yyyy-mm-dd hh:mm:ss" UTC"';
}

export async function toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleHeader(header: ExcelJS.Row, color: string): void {
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
}
