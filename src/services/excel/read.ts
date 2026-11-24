import ExcelJS from 'exceljs';
import { MAX_CAMPAIGN_ROWS } from '../../config/constants.js';
import type { CampaignChannel } from '../../types/index.js';
import { inputColumnsFor, type EmailFields, type ImportRow, type InputField } from './columns.js';

type Field = InputField | keyof EmailFields;

interface ColumnPosition {
    header: string;
    field: Field;
    column: number;
}

export async function readExcel(source: string | Buffer, channel: CampaignChannel = 'whatsapp'): Promise<ImportRow[]> {
    return channelRows(await firstSheet(source), channel);
}

// Loads the workbook once and reads each channel's columns from the same sheet.
export async function readExcelChannels(source: string | Buffer, channels: readonly CampaignChannel[]): Promise<Map<CampaignChannel, ImportRow[]>> {
    const sheet = await firstSheet(source);
    return new Map(channels.map(channel => [channel, channelRows(sheet, channel)]));
}

function channelRows(sheet: ExcelJS.Worksheet, channel: CampaignChannel): ImportRow[] {
    const columns = locateColumns(sheet.getRow(1), channel);
    const records: ImportRow[] = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) addRecord(records, readRecord(row, rowNumber, columns), columns);
    });
    return records;
}

async function firstSheet(source: string | Buffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    if (typeof source === 'string') await workbook.xlsx.readFile(source);
    else await workbook.xlsx.load(Uint8Array.from(source).buffer);
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) throw new Error('The workbook has no worksheets.');
    return sheet;
}

function locateColumns(header: ExcelJS.Row, channel: CampaignChannel): ColumnPosition[] {
    const positions = headerPositions(header, new Set(inputColumnsFor(channel).map(([name]) => name.toLowerCase())));
    return inputColumnsFor(channel).map(([name, field]) => {
        const column = positions.get(name.toLowerCase());
        if (column === undefined) throw new Error(`Missing Excel column header: ${name}.`);
        return { header: name, field, column };
    });
}

function headerPositions(header: ExcelJS.Row, expected: Set<string>): Map<string, number> {
    const positions = new Map<string, number>();
    header.eachCell((cell, column) => {
        const name = headerName(cell);
        if (!name || !expected.has(name)) return;
        if (positions.has(name)) throw new Error(`Duplicate Excel column header: ${String(cell.value).trim()}.`);
        positions.set(name, column);
    });
    return positions;
}

function headerName(cell: ExcelJS.Cell): string | undefined {
    if (typeof cell.value !== 'string') return undefined;
    const name = cell.value.trim().toLowerCase();
    return name === 'attachment' ? 'pdf filename' : name;
}

function readRecord(row: ExcelJS.Row, rowNumber: number, columns: readonly ColumnPosition[]): ImportRow {
    const record: ImportRow = { rowNumber, clientName: '', phone: '', message: '', pdfFilename: '', consentStatus: '', campaignId: '' };
    for (const { header, field, column } of columns) {
        try {
            record[field] = readCellText(row.getCell(column), field);
        } catch (error) {
            record.error ??= `${header}: ${(error as Error).message}.`;
        }
    }
    return record;
}

function addRecord(records: ImportRow[], record: ImportRow, columns: readonly ColumnPosition[]): void {
    const isEmpty = record.error === undefined && !columns.some(({ field }) => record[field]?.trim());
    if (isEmpty) return;
    if (records.length === MAX_CAMPAIGN_ROWS) throw new Error(`A workbook can contain at most ${MAX_CAMPAIGN_ROWS} contact rows.`);
    records.push(record);
}

function readCellText(cell: ExcelJS.Cell, field: Field): string {
    const value = cell.value;
    if (value === null) return '';
    if (cell.type === ExcelJS.ValueType.Merge) throw new Error('Merged cells cannot be imported');
    if (typeof value === 'string') return keepMessageSpacing(value, field);
    if (field === 'email' && isMatchingMailto(value)) return value.text.trim();
    if (typeof value === 'number' && isWholeNumberField(value, field)) return String(value);
    if (typeof value === 'object' && 'richText' in value) return keepMessageSpacing(value.richText.map(({ text }) => text).join(''), field);
    throw new Error('Enter a text value without formulas or hyperlinks');
}

function keepMessageSpacing(text: string, field: Field): string {
    return field === 'message' ? text : text.trim();
}

function isMatchingMailto(value: ExcelJS.CellValue): value is ExcelJS.CellHyperlinkValue {
    return typeof value === 'object' && value !== null && 'hyperlink' in value &&
        value.hyperlink.toLowerCase() === `mailto:${value.text.trim().toLowerCase()}`;
}

function isWholeNumberField(value: number, field: Field): boolean {
    return ['phone', 'campaignId'].includes(field) && Number.isSafeInteger(value) && value >= 0 && value < 1e15;
}
