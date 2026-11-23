import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { transaction } from '../database/connection.js';
import { CAMPAIGN_CHANNEL_LABELS, MESSAGE_STATUSES, type CampaignChannel, type CampaignState, type MessageStatus, type ReceiptStage } from '../types/index.js';

export interface PreparedRow {
    rowNumber: number;
    clientId: string;
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

type ClaimedMessage = MessageRecord & { transportMessageId: string };
type Outcome = 'SENT' | 'FAILED' | 'UNKNOWN' | 'RETRY' | 'SKIPPED';

export interface AttemptRecord {
    messageId: number;
    attemptNumber: number;
    transportMessageId: string;
    state: 'SENDING' | Outcome;
    startedAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
}

type SqlRow = Record<string, SQLOutputValue>;
const withdrawalError = 'Consent withdrawn';
const pendingStatuses = "('PENDING','VALIDATING','QUEUED')";
const sentStatuses = "('SENT','DELIVERED','READ')";
const terminalFaults = "('FAILED','UNKNOWN')";
const campaignSummaryQuery = `
    SELECT c.id, c.state, c.created_at, c.updated_at, c.is_test, c.channel,
        coalesce(sum(s.total), 0) AS total,
        coalesce(sum(s.total) FILTER (WHERE s.status IN ${pendingStatuses}), 0) AS queued,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'SENDING'), 0) AS processing,
        coalesce(sum(s.total) FILTER (WHERE s.status IN ${sentStatuses}), 0) AS completed,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'FAILED'), 0) AS failed,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'UNKNOWN'), 0) AS unknown,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'SKIPPED'), 0) AS skipped
    FROM campaigns c LEFT JOIN campaign_status_counts s ON s.campaign_id = c.id
`;

function nowIso(): string {
    return new Date().toISOString();
}

function nullableText(value: SQLOutputValue | undefined): string | null {
    return typeof value === 'string' ? value : null;
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

function campaignSummary(row: SqlRow): CampaignSummary {
    return {
        ...campaignMetadata(row),
        total: Number(row.total),
        queued: Number(row.queued),
        processing: Number(row.processing),
        completed: Number(row.completed),
        failed: Number(row.failed),
        unknown: Number(row.unknown),
        skipped: Number(row.skipped),
    };
}

function webDraftSettings(row: SqlRow): WebDraftSettings {
    const scriptHtml = nullableText(row.script_html);
    return {
        script: String(row.script),
        subject: String(row.subject),
        attachment: String(row.attachment),
        ...(scriptHtml ? { scriptHtml } : {}),
    };
}

function messageRecord(row: SqlRow): MessageRecord {
    const attachmentHash = nullableText(row.attachment_hash);
    const error = nullableText(row.import_error);
    const messageHtml = nullableText(row.message_html);
    const attemptCount = Number(row.attempt_count);

    return {
        id: Number(row.id),
        campaignId: String(row.campaign_id),
        rowNumber: Number(row.row_number),
        clientId: String(row.client_id),
        clientName: String(row.client_name),
        phone: row.channel === 'gmail' ? '' : String(row.recipient),
        ...(row.channel === 'gmail' ? { email: String(row.recipient), subject: String(row.subject) } : {}),
        message: String(row.message),
        ...(row.channel === 'gmail' && messageHtml ? { messageHtml } : {}),
        pdfFilename: String(row.pdf_filename),
        consentStatus: String(row.consent_status),
        ...(attachmentHash === null ? {} : { attachmentHash }),
        ...(error === null ? {} : { error }),
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

function attemptRecord(row: SqlRow): AttemptRecord {
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

export class Store {
    constructor(private readonly db: DatabaseSync) {}

    importCampaign(id: string, rows: PreparedRow[], isTest = false, channel: CampaignChannel = 'whatsapp', draft?: WebDraft): Campaign {
        return transaction(this.db, () => this.insertCampaign(id, rows, isTest, channel, draft));
    }

    /** Imports several campaigns together: either all of them are created or none are. */
    importCampaigns(campaigns: readonly { id: string; rows: PreparedRow[]; channel: CampaignChannel; draft?: WebDraft }[]): Campaign[] {
        return transaction(this.db, () => campaigns.map(({ id, rows, channel, draft }) => this.insertCampaign(id, rows, false, channel, draft)));
    }

    private insertCampaign(id: string, rows: PreparedRow[], isTest: boolean, channel: CampaignChannel, draft?: WebDraft): Campaign {
        if (this.db.prepare('SELECT id FROM campaigns WHERE id = ?').get(id)) {
            throw new Error(`Campaign "${id}" already exists`);
        }
        const timestamp = nowIso();
        this.db.prepare(`
            INSERT INTO campaigns(id, state, is_test, created_at, updated_at, channel) VALUES (?, 'Draft', ?, ?, ?, ?)
        `).run(id, Number(isTest), timestamp, timestamp, channel);
        if (draft) this.saveWebDraft(id, draft);
        const hasEligible = this.insertCampaignRows(id, channel, isTest, rows);
        return hasEligible ? this.setState(id, 'Ready') : this.getCampaign(id);
    }

    private insertCampaignRows(id: string, channel: CampaignChannel, isTest: boolean, rows: PreparedRow[]): boolean {
        const insert = this.db.prepare(`
            INSERT INTO messages(
                campaign_id, row_number, client_id, client_name, recipient, subject, message, pdf_filename, consent_status,
                attachment_hash, import_error, eligible, status, error_message, message_html
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const withdrawn = this.db.prepare('SELECT 1 FROM consent_withdrawals WHERE recipient = ? AND channel = ?');
        const acceptedRecipients = new Set<string>();
        const acceptedClientIds = new Set<string>();
        for (const row of rows) {
            let error = row.error ?? null;
            const clientKey = row.clientId.toLowerCase();
            const recipient = channel === 'gmail' ? row.email ?? '' : row.phone;
            if (!error && row.consentStatus.trim().toLowerCase() !== 'opted in') error = 'Consent is required';
            if (!error && !recipient) error = channel === 'gmail' ? 'Invalid email address' : 'Invalid phone number';
            if (!error && withdrawn.get(recipient, channel)) error = withdrawalError;
            if (!error && (acceptedRecipients.has(recipient) || acceptedClientIds.has(clientKey))) {
                error = 'Duplicate recipient or client ID';
            }
            if (!error) {
                acceptedRecipients.add(recipient);
                acceptedClientIds.add(clientKey);
            }
            insert.run(
                id, row.rowNumber, row.clientId, row.clientName, recipient, row.subject ?? '', row.message, row.pdfFilename,
                row.consentStatus, row.attachmentHash ?? null, error, Number(error === null),
                error ? 'SKIPPED' : 'PENDING', error, channel === 'gmail' ? row.messageHtml ?? null : null,
            );
        }

        if (isTest && acceptedRecipients.size > 1) throw new Error('A test campaign may contain only one eligible recipient');
        return acceptedRecipients.size > 0;
    }

    private saveWebDraft(id: string, draft: WebDraft): void {
        this.db.prepare(`
            INSERT INTO web_campaign_drafts(campaign_id, workbook, script, subject, attachment, script_html) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(campaign_id) DO UPDATE SET workbook = excluded.workbook, script = excluded.script,
                subject = excluded.subject, attachment = excluded.attachment, script_html = excluded.script_html
        `).run(id, draft.workbook, draft.script, draft.subject, draft.attachment, draft.scriptHtml ?? null);
    }

    getWebDraft(id: string): WebDraft | null {
        const row = this.db.prepare('SELECT workbook, script, subject, attachment, script_html FROM web_campaign_drafts WHERE campaign_id = ?').get(id);
        if (!row) return null;
        if (!(row.workbook instanceof Uint8Array)) throw new Error('The imported workbook is unavailable');
        return { ...webDraftSettings(row), workbook: Buffer.from(row.workbook) };
    }

    getWebDraftSettings(id: string): WebDraftSettings | null {
        const row = this.db.prepare('SELECT script, subject, attachment, script_html FROM web_campaign_drafts WHERE campaign_id = ?').get(id);
        return row ? webDraftSettings(row) : null;
    }

    replaceWebDraft(id: string, rows: PreparedRow[], draft: WebDraft): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (campaign.accountId || !['Draft', 'Ready'].includes(campaign.state) || !this.getWebDraftSettings(id)) {
                throw new Error('Only a web draft that has never started can be edited');
            }
            if (this.db.prepare('SELECT 1 FROM messages WHERE campaign_id = ? AND attempt_count > 0 LIMIT 1').get(id)) {
                throw new Error('Cannot edit a campaign that already has delivery attempts');
            }
            this.db.prepare('DELETE FROM messages WHERE campaign_id = ?').run(id);
            this.saveWebDraft(id, draft);
            const hasEligible = this.insertCampaignRows(id, campaign.channel, campaign.isTest, rows);
            return this.setState(id, hasEligible ? 'Ready' : 'Draft');
        });
    }

    getCampaign(id: string): Campaign {
        const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
        if (!row) throw new Error(`Campaign "${id}" does not exist`);
        return { ...campaignMetadata(row), accountId: nullableText(row.account_id) };
    }

    listCampaignSummaries(): CampaignSummary[] {
        return this.db.prepare(`${campaignSummaryQuery} GROUP BY c.id ORDER BY c.created_at DESC, c.id`).all().map(campaignSummary);
    }

    campaignSummary(id: string): CampaignSummary {
        const row = this.db.prepare(`${campaignSummaryQuery} WHERE c.id = ? GROUP BY c.id`).get(id);
        if (!row) throw new Error(`Campaign "${id}" does not exist`);
        return campaignSummary(row);
    }

    listMessages(id: string): MessageRecord[] {
        this.getCampaign(id);
        return this.db.prepare('SELECT m.*, c.channel FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE c.id = ? ORDER BY m.row_number').all(id).map(messageRecord);
    }

    listMessagePage(id: string, page: number, pageSize: number): { rows: MessageRecord[]; page: number; totalPages: number } {
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
            throw new Error('Use a positive page and page size');
        }
        const campaign = this.campaignSummary(id);
        const totalPages = Math.max(1, Math.ceil(campaign.total / pageSize));
        const requestedPage = Math.min(page, totalPages);
        const rows = this.db.prepare(`
            SELECT m.*, ? AS channel FROM messages m WHERE m.campaign_id = ? ORDER BY m.row_number LIMIT ? OFFSET ?
        `).all(campaign.channel, id, pageSize, (requestedPage - 1) * pageSize).map(messageRecord);
        return { rows, page: requestedPage, totalPages };
    }

    progress(id: string): Record<MessageStatus, number> {
        this.getCampaign(id);
        const result = Object.fromEntries(MESSAGE_STATUSES.map(status => [status, 0])) as Record<MessageStatus, number>;
        const rows = this.db.prepare(`
      SELECT status, count(*) AS total FROM messages WHERE campaign_id = ? GROUP BY status
    `).all(id);
        for (const row of rows) result[row.status as MessageStatus] = Number(row.total);
        return result;
    }

    start(id: string): Campaign {
        return this.activate(id, ['Ready']);
    }

    resume(id: string): Campaign {
        return this.activate(id, ['Paused', 'Failed']);
    }

    pause(id: string): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (campaign.state === 'Paused') return campaign;
            if (campaign.state !== 'Running') throw new Error(`Cannot pause a ${campaign.state} campaign`);
            return this.setState(id, 'Paused');
        });
    }

    pauseIfRunning(id: string): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            return campaign.state === 'Running' ? this.setState(id, 'Paused') : campaign;
        });
    }

    cancel(id: string): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (campaign.state === 'Cancelled') return campaign;
            if (campaign.state === 'Completed') throw new Error('Cannot cancel a completed campaign');

            this.db.prepare(`
        UPDATE messages SET status = 'SKIPPED', error_message = 'Campaign cancelled'
        WHERE campaign_id = ? AND status IN ${pendingStatuses}
      `).run(id);
            return this.setState(id, 'Cancelled');
        });
    }

    retryFailed(id: string): number {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (!['Paused', 'Completed', 'Failed'].includes(campaign.state) || this.hasActiveAttempts(id)) {
                throw new Error('Cannot retry until the campaign is paused or finished and any in-flight attempts settle');
            }
            const result = this.db.prepare(`
                UPDATE messages SET status = 'QUEUED', retry_at = 0, error_message = NULL
                WHERE campaign_id = ? AND status = 'FAILED' AND eligible = 1
                    AND NOT EXISTS (
                        SELECT 1 FROM consent_withdrawals WHERE recipient = messages.recipient AND channel = ?
                    )
            `).run(id, campaign.channel);
            if (result.changes) this.setState(id, 'Paused');
            return Number(result.changes);
        });
    }

    deleteCampaign(id: string): void {
        transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (campaign.state === 'Running' || this.hasActiveAttempts(id)) {
                throw new Error('Cannot delete until the campaign stops and any in-flight attempts settle');
            }
            this.db.prepare('DELETE FROM confirmed_test WHERE campaign_id = ?').run(id);
            this.db.prepare('DELETE FROM message_attempts WHERE message_id IN (SELECT id FROM messages WHERE campaign_id = ?)').run(id);
            this.db.prepare('DELETE FROM messages WHERE campaign_id = ?').run(id);
            this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
        });
    }

    private hasActiveAttempts(id: string): boolean {
        return Boolean(this.db.prepare(`
            SELECT 1 FROM messages m WHERE m.campaign_id = ? AND (
                m.status = 'SENDING' OR EXISTS (
                    SELECT 1 FROM message_attempts a WHERE a.message_id = m.id AND a.state = 'SENDING'
                )
            ) LIMIT 1
        `).get(id));
    }

    setCampaignFailed(id: string): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            return campaign.state === 'Running' ? this.setState(id, 'Failed') : campaign;
        });
    }

    private setState(id: string, state: CampaignState): Campaign {
        this.db.prepare('UPDATE campaigns SET state = ?, updated_at = ? WHERE id = ?').run(state, nowIso(), id);
        return this.getCampaign(id);
    }

    private activate(id: string, states: CampaignState[]): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (!states.includes(campaign.state)) {
                throw new Error(`Campaign "${id}" is ${campaign.state}. Expected ${states.join(' or ')}`);
            }
            const pending = this.db.prepare(`
        SELECT 1 FROM messages WHERE campaign_id = ? AND status IN ${pendingStatuses} LIMIT 1
      `).get(id);
            if (!pending) throw new Error('Campaign has no eligible pending messages');
            this.db.prepare("UPDATE messages SET status = 'QUEUED' WHERE campaign_id = ? AND status = 'PENDING'").run(id);
            return this.setState(id, 'Running');
        });
    }

    bindAccount(id: string, accountId: string): void {
        transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            const label = CAMPAIGN_CHANNEL_LABELS[campaign.channel];
            if (!accountId) throw new Error(`${label} account identity is unavailable`);
            if (campaign.accountId !== null && campaign.accountId !== accountId) {
                throw new Error(`Campaign is bound to a different ${label} account`);
            }
            this.db.prepare('UPDATE campaigns SET account_id = ? WHERE id = ?').run(accountId, id);
        });
    }

    hasConfirmedTest(accountId: string): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM confirmed_test WHERE account_id = ?').get(accountId));
    }

    confirmTest(id: string, accountId?: string): void {
        transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (!campaign.isTest) throw new Error('Use a registered single-contact test campaign for confirmation');
            if (!campaign.accountId || (accountId !== undefined && campaign.accountId !== accountId)) {
                throw new Error(`Test confirmation requires the ${CAMPAIGN_CHANNEL_LABELS[campaign.channel]} account used for the send`);
            }
            const eligible = this.db.prepare('SELECT status FROM messages WHERE campaign_id = ? AND eligible = 1').all(id);
            if (eligible.length !== 1 || !['SENT', 'DELIVERED', 'READ'].includes(String(eligible[0]?.status))) {
                throw new Error('Test confirmation requires one successfully submitted test message');
            }
            this.db.prepare(`
        INSERT INTO confirmed_test(account_id, campaign_id, confirmed_at) VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET campaign_id = excluded.campaign_id, confirmed_at = excluded.confirmed_at
      `).run(campaign.accountId, id, nowIso());
        });
    }

    peek(id: string, now = Date.now()): MessageRecord | undefined {
        const row = this.db.prepare(`
      SELECT m.*, c.channel FROM messages m JOIN campaigns c ON c.id = m.campaign_id
      WHERE c.id = ? AND c.state = 'Running' AND m.status = 'QUEUED' AND m.retry_at <= ?
        AND NOT EXISTS (SELECT 1 FROM consent_withdrawals w WHERE w.recipient = m.recipient AND w.channel = c.channel)
      ORDER BY m.id LIMIT 1
    `).get(id, now);
        return row ? messageRecord(row) : undefined;
    }

    nextAvailableAt(id: string): number | undefined {
        const row = this.db.prepare(`
      SELECT min(m.retry_at) AS available_at FROM messages m JOIN campaigns c ON c.id = m.campaign_id
      WHERE c.id = ? AND c.state = 'Running' AND m.status = 'QUEUED'
        AND NOT EXISTS (SELECT 1 FROM consent_withdrawals w WHERE w.recipient = m.recipient AND w.channel = c.channel)
    `).get(id);
        return typeof row?.available_at === 'number' ? row.available_at : undefined;
    }

    claim(id: string, messageId: number, transportId: string): ClaimedMessage | undefined {
        return transaction(this.db, () => {
            const row = this.db.prepare(`
        UPDATE messages SET status = 'SENDING', transport_message_id = coalesce(transport_message_id, ?),
          attempt_count = attempt_count + 1, error_message = NULL
        WHERE id = ? AND campaign_id = ? AND status = 'QUEUED' AND retry_at <= ?
          AND EXISTS (
            SELECT 1 FROM campaigns c WHERE c.id = campaign_id AND c.state = 'Running'
              AND NOT EXISTS (
                SELECT 1 FROM consent_withdrawals w WHERE w.recipient = messages.recipient AND w.channel = c.channel
              )
          )
        RETURNING *, (SELECT channel FROM campaigns WHERE id = campaign_id) AS channel
      `).get(transportId, messageId, id, Date.now());
            if (!row) return undefined;
            const message = messageRecord(row);
            if (!message.transportMessageId) throw new Error('Claimed message is missing its transport message ID');
            this.db.prepare(`
        INSERT INTO message_attempts(message_id, attempt_number, transport_message_id, state, started_at)
        VALUES (?, ?, ?, 'SENDING', ?)
      `).run(message.id, message.attemptCount, message.transportMessageId, nowIso());
            return { ...message, transportMessageId: message.transportMessageId };
        });
    }

    canSubmit(messageId: number): boolean {
        return Boolean(this.db.prepare(`
      SELECT 1 FROM messages m JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.id = ? AND m.status = 'SENDING' AND c.state = 'Running'
        AND NOT EXISTS (SELECT 1 FROM consent_withdrawals w WHERE w.recipient = m.recipient AND w.channel = c.channel)
    `).get(messageId));
    }

    finish(messageId: number, outcome: Outcome, error?: string, retryAt?: number, acknowledged = false): void {
        transaction(this.db, () => {
            const row = this.db.prepare(`
        SELECT m.status, m.error_message, m.attempt_count, c.state AS campaign_state,
          EXISTS(SELECT 1 FROM consent_withdrawals w WHERE w.recipient = m.recipient AND w.channel = c.channel) AS withdrawn
        FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = ?
      `).get(messageId);
            if (!row) throw new Error('Message does not exist');
            const attempt = this.db.prepare(`
        SELECT 1 FROM message_attempts WHERE message_id = ? AND attempt_number = ? AND state = 'SENDING'
      `).get(messageId, Number(row.attempt_count));
            if (!attempt) return;

            const timestamp = nowIso();
            if (['SENT', 'DELIVERED', 'READ'].includes(String(row.status))) {
                this.finishAttempt(messageId, Number(row.attempt_count), 'SENT', timestamp, null);
                return;
            }
            if (row.status === 'UNKNOWN') {
                this.finishAttempt(messageId, Number(row.attempt_count), 'UNKNOWN', timestamp, nullableText(row.error_message));
                return;
            }
            if (row.status !== 'SENDING') throw new Error('Message is no longer being processed');

            const cancelled = row.campaign_state === 'Cancelled';
            const withdrawn = row.withdrawn === 1;
            if (outcome === 'RETRY' && (cancelled || withdrawn)) {
                outcome = 'SKIPPED';
                error = withdrawn ? withdrawalError : 'Campaign cancelled';
            }

            this.db.prepare(`
        UPDATE messages SET status = ?, error_message = ?, retry_at = ?,
          sent_at = CASE WHEN ? = 'SENT' THEN coalesce(sent_at, ?) ELSE sent_at END,
          acknowledged_at = CASE WHEN ? THEN coalesce(acknowledged_at, ?) ELSE acknowledged_at END
        WHERE id = ?
      `).run(outcome === 'RETRY' ? 'QUEUED' : outcome, error ?? null, retryAt ?? 0, outcome, timestamp, Number(outcome === 'SENT' && acknowledged), timestamp, messageId);
            this.finishAttempt(messageId, Number(row.attempt_count), outcome, timestamp, error ?? null);
        });
    }

    private finishAttempt(
        messageId: number,
        attemptNumber: number,
        outcome: Outcome,
        timestamp: string,
        error: string | null,
    ): void {
        this.db.prepare(`
      UPDATE message_attempts SET state = ?, finished_at = ?, error_message = ?
      WHERE message_id = ? AND attempt_number = ? AND state = 'SENDING'
    `).run(outcome, timestamp, error, messageId, attemptNumber);
    }

    receipt(whatsappId: string, stage: ReceiptStage): void {
        const timestamp = nowIso();
        if (stage === 'REJECTED') {
            this.db.prepare(`
        UPDATE messages SET status = 'UNKNOWN', error_message = 'WhatsApp reported a send error. Review the outcome.'
        WHERE transport_message_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'whatsapp') AND status IN ('SENDING', 'SENT', 'QUEUED') AND acknowledged_at IS NULL
      `).run(whatsappId);
            return;
        }

        this.db.prepare(`
      UPDATE messages SET
        status = CASE
          WHEN status = 'READ' OR ? = 'READ' THEN 'READ'
          WHEN status = 'DELIVERED' OR ? = 'DELIVERED' THEN 'DELIVERED'
          ELSE 'SENT'
        END,
        sent_at = coalesce(sent_at, ?),
        acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN coalesce(acknowledged_at, ?) ELSE acknowledged_at END,
        delivered_at = CASE WHEN ? = 'DELIVERED' THEN coalesce(delivered_at, ?) ELSE delivered_at END,
        read_at = CASE WHEN ? = 'READ' THEN coalesce(read_at, ?) ELSE read_at END,
        error_message = NULL
      WHERE transport_message_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'whatsapp')
    `).run(stage, stage, timestamp, stage, timestamp, stage, timestamp, stage, timestamp, whatsappId);
    }

    recover(): number {
        return transaction(this.db, () => {
            const timestamp = nowIso();
            const crashError = 'Interrupted during an attempt. Review the delivery outcome.';
            const recovered = this.db.prepare(`
        UPDATE messages SET status = 'UNKNOWN', error_message = ? WHERE status = 'SENDING'
      `).run(crashError);
            this.db.prepare(`
        UPDATE message_attempts SET
          state = CASE WHEN messages.status IN ${sentStatuses} THEN 'SENT' ELSE 'UNKNOWN' END,
          finished_at = ?,
          error_message = CASE WHEN messages.status IN ${sentStatuses} THEN NULL ELSE coalesce(messages.error_message, ?) END
        FROM messages WHERE message_attempts.message_id = messages.id AND message_attempts.state = 'SENDING'
      `).run(timestamp, crashError);
            this.db.prepare(`
        UPDATE campaigns SET state = CASE
          WHEN EXISTS(SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ${pendingStatuses})
            THEN 'Paused'
          WHEN EXISTS(SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ${sentStatuses})
            THEN 'Completed'
          WHEN EXISTS(SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ${terminalFaults})
            THEN 'Failed'
          ELSE 'Completed'
        END, updated_at = ?
        WHERE state = 'Running' OR (state = 'Paused' AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ${pendingStatuses}
        ))
      `).run(timestamp);
            return Number(recovered.changes);
        });
    }

    settleCampaign(id: string): Campaign {
        return transaction(this.db, () => {
            const campaign = this.getCampaign(id);
            if (campaign.state !== 'Running' && campaign.state !== 'Paused') return campaign;
            const stats = this.db.prepare(`
        SELECT count(*) FILTER (WHERE status IN ('PENDING','VALIDATING','QUEUED','SENDING')) AS pending_count,
          count(*) FILTER (WHERE status IN ${terminalFaults}) AS failed_count,
          count(*) FILTER (WHERE status IN ${sentStatuses}) AS sent_count
        FROM messages WHERE campaign_id = ?
      `).get(id);
            if (stats?.pending_count !== 0) return campaign;
            return this.setState(id, Number(stats.failed_count) > 0 && stats.sent_count === 0 ? 'Failed' : 'Completed');
        });
    }

    withdraw(recipient: string, channel: CampaignChannel = 'whatsapp'): number {
        return transaction(this.db, () => {
            this.db.prepare(`
        INSERT INTO consent_withdrawals(recipient, withdrawn_at, channel) VALUES (?, ?, ?) ON CONFLICT(channel, recipient) DO NOTHING
      `).run(recipient, nowIso(), channel);
            const result = this.db.prepare(`
        UPDATE messages SET status = 'SKIPPED', error_message = ?
        WHERE recipient = ? AND campaign_id IN (SELECT id FROM campaigns WHERE channel = ?) AND status IN ${pendingStatuses}
      `).run(withdrawalError, recipient, channel);
            return Number(result.changes);
        });
    }

    isWithdrawn(recipient: string, channel: CampaignChannel = 'whatsapp'): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM consent_withdrawals WHERE recipient = ? AND channel = ?').get(recipient, channel));
    }

    review(messageId: number, resolution: 'SENT' | 'FAILED', note: string, campaignId?: string): void {
        if (!note.trim()) throw new Error('A review note is required');
        const timestamp = nowIso();
        const result = this.db.prepare(`
      UPDATE messages SET status = ?,
        sent_at = CASE WHEN ? = 'SENT' THEN coalesce(sent_at, ?) ELSE sent_at END,
        error_message = CASE WHEN ? = 'SENT' THEN NULL ELSE error_message END,
        reviewed_at = ?, review_note = ?
      WHERE id = ? AND (? IS NULL OR campaign_id = ?) AND status = 'UNKNOWN' AND NOT EXISTS (
        SELECT 1 FROM message_attempts a WHERE a.message_id = messages.id AND a.state = 'SENDING'
      )
    `).run(resolution, resolution, timestamp, resolution, timestamp, note, messageId, campaignId ?? null, campaignId ?? null);
        if (result.changes === 0) throw new Error('Only messages with unknown outcomes can be reviewed');
    }

    attempts(messageId: number): AttemptRecord[] {
        return this.db.prepare('SELECT * FROM message_attempts WHERE message_id = ? ORDER BY attempt_number')
            .all(messageId).map(attemptRecord);
    }

    listAttempts(id: string): AttemptRecord[] {
        this.getCampaign(id);
        return this.db.prepare(`
      SELECT a.* FROM message_attempts a JOIN messages m ON m.id = a.message_id
      WHERE m.campaign_id = ? ORDER BY m.row_number, a.attempt_number
    `).all(id).map(attemptRecord);
    }
}
