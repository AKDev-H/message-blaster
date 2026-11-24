import type { DatabaseSync } from 'node:sqlite';
import { MESSAGE_STATUSES, type CampaignChannel, type MessageStatus } from '../types/index.js';
import { getCampaign, getCampaignSummary } from './campaigns.js';
import { withdrawalChecker } from './consent.js';
import { toMessageRecord, type MessageRecord, type PreparedRow } from './records.js';
import { WITHDRAWAL_ERROR } from './statuses.js';

const INSERT_MESSAGE = `
    INSERT INTO messages(
        campaign_id, row_number, client_id, client_name, recipient, subject, message, pdf_filename, consent_status,
        attachment_hash, import_error, eligible, status, error_message, message_html
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const LIST_MESSAGES = `
    SELECT m.*, c.channel FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE c.id = ? ORDER BY m.row_number
`;
const MESSAGE_PAGE = `
    SELECT m.*, ? AS channel FROM messages m WHERE m.campaign_id = ? ORDER BY m.row_number LIMIT ? OFFSET ?
`;
const STATUS_COUNTS = 'SELECT status, count(*) AS total FROM messages WHERE campaign_id = ? GROUP BY status';

export interface MessagePage {
    rows: MessageRecord[];
    page: number;
    totalPages: number;
}

export function insertRecipients(db: DatabaseSync, id: string, channel: CampaignChannel, isTest: boolean, rows: PreparedRow[]): boolean {
    const insert = db.prepare(INSERT_MESSAGE);
    const accepted = new Set<string>();
    const isWithdrawn = withdrawalChecker(db, channel);
    for (const row of rows) {
        const recipient = channel === 'gmail' ? row.email ?? '' : row.phone;
        const error = skipReason(row, recipient, channel, isWithdrawn(recipient), accepted.has(recipient));
        if (error === null) accepted.add(recipient);
        insert.run(...messageValues(id, channel, row, recipient, error));
    }
    if (isTest && accepted.size > 1) throw new Error('A test campaign may contain only one eligible recipient');
    return accepted.size > 0;
}

export function deleteRecipients(db: DatabaseSync, id: string): void {
    db.prepare('DELETE FROM messages WHERE campaign_id = ?').run(id);
}

export function listMessages(db: DatabaseSync, id: string): MessageRecord[] {
    getCampaign(db, id);
    return db.prepare(LIST_MESSAGES).all(id).map(toMessageRecord);
}

export function listMessagePage(db: DatabaseSync, id: string, page: number, pageSize: number): MessagePage {
    if (!isPositiveInteger(page) || !isPositiveInteger(pageSize)) throw new Error('Use a positive page and page size');
    const campaign = getCampaignSummary(db, id);
    const totalPages = Math.max(1, Math.ceil(campaign.total / pageSize));
    const shown = Math.min(page, totalPages);
    const rows = db.prepare(MESSAGE_PAGE).all(campaign.channel, id, pageSize, (shown - 1) * pageSize).map(toMessageRecord);
    return { rows, page: shown, totalPages };
}

export function countByStatus(db: DatabaseSync, id: string): Record<MessageStatus, number> {
    getCampaign(db, id);
    const counts = Object.fromEntries(MESSAGE_STATUSES.map(status => [status, 0])) as Record<MessageStatus, number>;
    for (const row of db.prepare(STATUS_COUNTS).all(id)) counts[row.status as MessageStatus] = Number(row.total);
    return counts;
}

function skipReason(row: PreparedRow, recipient: string, channel: CampaignChannel, withdrawn: boolean, duplicate: boolean) {
    if (row.error) return row.error;
    if (row.consentStatus.trim().toLowerCase() !== 'opted in') return 'Consent is required';
    if (!recipient) return channel === 'gmail' ? 'Invalid email address' : 'Invalid phone number';
    if (withdrawn) return WITHDRAWAL_ERROR;
    if (duplicate) return 'Duplicate recipient';
    return null;
}

function messageValues(id: string, channel: CampaignChannel, row: PreparedRow, recipient: string, error: string | null) {
    const html = channel === 'gmail' ? row.messageHtml ?? null : null;
    const status = error ? 'SKIPPED' : 'PENDING';
    return [
        id, row.rowNumber, '', row.clientName, recipient, row.subject ?? '', row.message, row.pdfFilename,
        row.consentStatus, row.attachmentHash ?? null, error, Number(error === null), status, error, html,
    ];
}

function isPositiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}
