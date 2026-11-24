import type { SQLOutputValue } from 'node:sqlite';
import type { CampaignChannel, CampaignState, MessageStatus } from '../types/index.js';

export type SqlRow = Record<string, SQLOutputValue>;

export interface PreparedRow {
    rowNumber: number;
    clientName: string;
    phone: string;
    email?: string;
    subject?: string;
    message: string;
    messageHtml?: string;
    pdfFilename: string;
    consentStatus: string;
    attachmentHash?: string;
    error?: string;
}

export interface Campaign {
    id: string;
    state: CampaignState;
    createdAt: string;
    updatedAt: string;
    accountId: string | null;
    isTest: boolean;
    channel: CampaignChannel;
}

export interface CampaignSummary extends Omit<Campaign, 'accountId'> {
    total: number;
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    unknown: number;
    skipped: number;
}

export interface WebDraftSettings {
    script: string;
    scriptHtml?: string;
    subject: string;
    attachment: string;
}

export interface WebDraft extends WebDraftSettings {
    workbook: Buffer;
}

export interface MessageRecord extends PreparedRow {
    id: number;
    campaignId: string;
    eligible: boolean;
    status: MessageStatus;
    transportMessageId: string | null;
    sentAt: string | null;
    acknowledgedAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    errorMessage: string | null;
    attemptCount: number;
    retryCount: number;
    reviewedAt: string | null;
    reviewNote: string | null;
}

export type ClaimedMessage = MessageRecord & { transportMessageId: string };
export type Outcome = 'SENT' | 'FAILED' | 'UNKNOWN' | 'RETRY' | 'SKIPPED';

export interface AttemptRecord {
    messageId: number;
    attemptNumber: number;
    transportMessageId: string;
    state: 'SENDING' | Outcome;
    startedAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function nullableText(value: SQLOutputValue | undefined): string | null {
    return typeof value === 'string' ? value : null;
}

export function toCampaign(row: SqlRow): Campaign {
    return { ...campaignMetadata(row), accountId: nullableText(row.account_id) };
}

export function toCampaignSummary(row: SqlRow): CampaignSummary {
    const count = (key: string) => Number(row[key]);
    return {
        ...campaignMetadata(row),
        total: count('total'), queued: count('queued'), processing: count('processing'), completed: count('completed'),
        failed: count('failed'), unknown: count('unknown'), skipped: count('skipped'),
    };
}

export function toWebDraftSettings(row: SqlRow): WebDraftSettings {
    const scriptHtml = nullableText(row.script_html);
    const settings = { script: String(row.script), subject: String(row.subject), attachment: String(row.attachment) };
    return scriptHtml ? { ...settings, scriptHtml } : settings;
}

export function toMessageRecord(row: SqlRow): MessageRecord {
    return { ...messageContent(row), ...messageProgress(row) };
}

export function toAttemptRecord(row: SqlRow): AttemptRecord {
    return {
        messageId: Number(row.message_id),
        attemptNumber: Number(row.attempt_number),
        transportMessageId: String(row.transport_message_id),
        state: row.state as AttemptRecord['state'],
        startedAt: String(row.started_at),
        finishedAt: nullableText(row.finished_at),
        errorMessage: nullableText(row.error_message),
    };
}

function campaignMetadata(row: SqlRow): Omit<Campaign, 'accountId'> {
    return {
        id: String(row.id),
        state: row.state as CampaignState,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        isTest: row.is_test === 1,
        channel: row.channel as CampaignChannel,
    };
}

function messageContent(row: SqlRow) {
    return {
        id: Number(row.id),
        campaignId: String(row.campaign_id),
        rowNumber: Number(row.row_number),
        clientName: String(row.client_name),
        ...recipientAddress(row),
        message: String(row.message),
        ...optionalText('messageHtml', row.channel === 'gmail' && row.message_html ? row.message_html : null),
        pdfFilename: String(row.pdf_filename),
        consentStatus: String(row.consent_status),
        ...optionalText('attachmentHash', row.attachment_hash),
        ...optionalText('error', row.import_error),
    };
}

function messageProgress(row: SqlRow) {
    const attemptCount = Number(row.attempt_count);
    return {
        eligible: row.eligible === 1,
        status: row.status as MessageStatus,
        transportMessageId: nullableText(row.transport_message_id),
        sentAt: nullableText(row.sent_at),
        acknowledgedAt: nullableText(row.acknowledged_at),
        deliveredAt: nullableText(row.delivered_at),
        readAt: nullableText(row.read_at),
        errorMessage: nullableText(row.error_message),
        attemptCount,
        retryCount: Math.max(0, attemptCount - 1),
        reviewedAt: nullableText(row.reviewed_at),
        reviewNote: nullableText(row.review_note),
    };
}

function recipientAddress(row: SqlRow): { phone: string; email?: string; subject?: string } {
    if (row.channel !== 'gmail') return { phone: String(row.recipient) };
    return { phone: '', email: String(row.recipient), subject: String(row.subject) };
}

function optionalText<K extends string>(key: K, value: SQLOutputValue | undefined): { [P in K]?: string } {
    const text = nullableText(value);
    return (text === null ? {} : { [key]: text }) as { [P in K]?: string };
}
