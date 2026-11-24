import type { CampaignChannel } from '../../types/index.js';

export type Column = readonly [header: string, key: string, width: number];

const INPUT_COLUMNS = [
    ['Client Name', 'clientName', 25],
    ['Phone Number', 'phone', 22],
    ['Message', 'message', 54],
    ['PDF Filename', 'pdfFilename', 27],
    ['Consent Status', 'consentStatus', 20],
    ['Campaign ID', 'campaignId', 18],
] as const;

const GMAIL_INPUT_COLUMNS = [
    INPUT_COLUMNS[0],
    ['Email Address', 'email', 34],
    ['Subject', 'subject', 40],
    ...INPUT_COLUMNS.slice(2),
] as const;

const STATUS_COLUMN: Column = ['Sending Status', 'sendingStatus', 19];
const WHATSAPP_ID_COLUMN: Column = ['WhatsApp Message ID', 'whatsappMessageId', 31];
const GMAIL_ID_COLUMN: Column = ['Gmail Message ID', 'gmailMessageId', 48];
const RESULT_COLUMNS: readonly Column[] = [
    ['Sent At', 'sentAt', 23],
    ['Error Message', 'errorMessage', 48],
    ['Retry Count', 'retryCount', 16],
];
const RECEIPT_COLUMNS: readonly Column[] = [
    ['Server Acknowledged At', 'serverAcknowledgedAt', 25],
    ['Delivered At', 'deliveredAt', 23],
    ['Read At', 'readAt', 23],
];

export type InputField = (typeof INPUT_COLUMNS)[number][1];
export type EmailFields = { email?: string; subject?: string };
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

export function inputColumnsFor(channel: CampaignChannel) {
    return channel === 'gmail' ? GMAIL_INPUT_COLUMNS : INPUT_COLUMNS;
}

export function receiptColumnsFor(channel: CampaignChannel, results: boolean): readonly Column[] {
    if (!results) return [];
    return channel === 'gmail' ? RECEIPT_COLUMNS.slice(0, 1) : RECEIPT_COLUMNS;
}

export function trackingColumnsFor(channel: CampaignChannel, results: boolean): Column[] {
    const transportId = channel === 'gmail' ? GMAIL_ID_COLUMN : WHATSAPP_ID_COLUMN;
    return [...inputColumnsFor(channel), STATUS_COLUMN, transportId, ...RESULT_COLUMNS, ...receiptColumnsFor(channel, results)];
}

export function blankTemplateColumns(channel: CampaignChannel | 'both'): Column[] {
    if (channel !== 'both') return [...inputColumnsFor(channel)];
    return [...GMAIL_INPUT_COLUMNS.slice(0, 2), INPUT_COLUMNS[1], ...GMAIL_INPUT_COLUMNS.slice(2)];
}
