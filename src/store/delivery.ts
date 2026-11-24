import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { NotFoundError } from '../errors.js';
import { nowIso, nullableText, toMessageRecord, type ClaimedMessage, type MessageRecord, type Outcome, type SqlRow } from './records.js';
import { CANCELLED_ERROR, RECIPIENT_WITHDRAWN, SENT_STATUS_NAMES, WITHDRAWAL_ERROR } from './statuses.js';

const NEXT_QUEUED = `
    SELECT m.*, c.channel FROM messages m JOIN campaigns c ON c.id = m.campaign_id
    WHERE c.id = ? AND c.state = 'Running' AND m.status = 'QUEUED' AND m.retry_at <= ? AND NOT ${RECIPIENT_WITHDRAWN}
    ORDER BY m.id LIMIT 1
`;
const EARLIEST_RETRY = `
    SELECT min(m.retry_at) AS available_at FROM messages m JOIN campaigns c ON c.id = m.campaign_id
    WHERE c.id = ? AND c.state = 'Running' AND m.status = 'QUEUED' AND NOT ${RECIPIENT_WITHDRAWN}
`;
const CLAIM = `
    UPDATE messages SET status = 'SENDING', transport_message_id = coalesce(transport_message_id, ?),
        attempt_count = attempt_count + 1, error_message = NULL
    WHERE id = ? AND campaign_id = ? AND status = 'QUEUED' AND retry_at <= ?
        AND EXISTS (
            SELECT 1 FROM campaigns c WHERE c.id = campaign_id AND c.state = 'Running'
                AND NOT EXISTS (SELECT 1 FROM consent_withdrawals w WHERE w.recipient = messages.recipient AND w.channel = c.channel)
        )
    RETURNING *, (SELECT channel FROM campaigns WHERE id = campaign_id) AS channel
`;
const START_ATTEMPT = `
    INSERT INTO message_attempts(message_id, attempt_number, transport_message_id, state, started_at) VALUES (?, ?, ?, 'SENDING', ?)
`;
const CAN_SUBMIT = `
    SELECT 1 FROM messages m JOIN campaigns c ON c.id = m.campaign_id
    WHERE m.id = ? AND m.status = 'SENDING' AND c.state = 'Running' AND NOT ${RECIPIENT_WITHDRAWN}
`;
const MESSAGE_FOR_FINISH = `
    SELECT m.status, m.error_message, m.attempt_count, c.state AS campaign_state, ${RECIPIENT_WITHDRAWN} AS withdrawn
    FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = ?
`;
const OPEN_ATTEMPT = "SELECT 1 FROM message_attempts WHERE message_id = ? AND attempt_number = ? AND state = 'SENDING'";
const RECORD_OUTCOME = `
    UPDATE messages SET status = ?, error_message = ?, retry_at = ?,
        sent_at = CASE WHEN ? = 'SENT' THEN coalesce(sent_at, ?) ELSE sent_at END,
        acknowledged_at = CASE WHEN ? THEN coalesce(acknowledged_at, ?) ELSE acknowledged_at END
    WHERE id = ?
`;
const CLOSE_ATTEMPT = `
    UPDATE message_attempts SET state = ?, finished_at = ?, error_message = ?
    WHERE message_id = ? AND attempt_number = ? AND state = 'SENDING'
`;

export interface FinishDetails {
    error?: string | undefined;
    retryAt?: number | undefined;
    acknowledged?: boolean | undefined;
}

export function peekNextMessage(db: DatabaseSync, id: string, now: number): MessageRecord | undefined {
    const row = db.prepare(NEXT_QUEUED).get(id, now);
    return row ? toMessageRecord(row) : undefined;
}

export function nextAvailableAt(db: DatabaseSync, id: string): number | undefined {
    const row = db.prepare(EARLIEST_RETRY).get(id);
    return typeof row?.available_at === 'number' ? row.available_at : undefined;
}

export function claimMessage(db: DatabaseSync, id: string, messageId: number, transportId: string): ClaimedMessage | undefined {
    return transaction(db, () => {
        const row = db.prepare(CLAIM).get(transportId, messageId, id, Date.now());
        if (!row) return undefined;
        const message = toMessageRecord(row);
        if (!message.transportMessageId) throw new Error('Claimed message is missing its transport message ID');
        db.prepare(START_ATTEMPT).run(message.id, message.attemptCount, message.transportMessageId, nowIso());
        return { ...message, transportMessageId: message.transportMessageId };
    });
}

export function canSubmit(db: DatabaseSync, messageId: number): boolean {
    return Boolean(db.prepare(CAN_SUBMIT).get(messageId));
}

export function finishMessage(db: DatabaseSync, messageId: number, outcome: Outcome, details: FinishDetails): void {
    transaction(db, () => {
        const row = db.prepare(MESSAGE_FOR_FINISH).get(messageId);
        if (!row) throw new NotFoundError('Message does not exist');
        const attempt = Number(row.attempt_count);
        if (!db.prepare(OPEN_ATTEMPT).get(messageId, attempt)) return;
        if (closeSettledAttempt(db, messageId, attempt, row)) return;
        if (row.status !== 'SENDING') throw new Error('Message is no longer being processed');
        recordOutcome(db, messageId, attempt, retryOrSkip(row, outcome, details));
    });
}

function closeSettledAttempt(db: DatabaseSync, messageId: number, attempt: number, row: SqlRow): boolean {
    const timestamp = nowIso();
    if (SENT_STATUS_NAMES.includes(String(row.status))) closeAttempt(db, messageId, attempt, 'SENT', timestamp, null);
    else if (row.status === 'UNKNOWN') closeAttempt(db, messageId, attempt, 'UNKNOWN', timestamp, nullableText(row.error_message));
    else return false;
    return true;
}

function retryOrSkip(row: SqlRow, outcome: Outcome, details: FinishDetails): { outcome: Outcome } & FinishDetails {
    const withdrawn = row.withdrawn === 1;
    if (outcome !== 'RETRY' || (row.campaign_state !== 'Cancelled' && !withdrawn)) return { outcome, ...details };
    return { ...details, outcome: 'SKIPPED', error: withdrawn ? WITHDRAWAL_ERROR : CANCELLED_ERROR };
}

function recordOutcome(db: DatabaseSync, messageId: number, attempt: number, result: { outcome: Outcome } & FinishDetails): void {
    const { outcome, error = null, retryAt = 0, acknowledged = false } = result;
    const timestamp = nowIso();
    const status = outcome === 'RETRY' ? 'QUEUED' : outcome;
    const wasAcknowledged = Number(outcome === 'SENT' && acknowledged);
    db.prepare(RECORD_OUTCOME).run(status, error, retryAt, outcome, timestamp, wasAcknowledged, timestamp, messageId);
    closeAttempt(db, messageId, attempt, outcome, timestamp, error);
}

function closeAttempt(db: DatabaseSync, messageId: number, attempt: number, outcome: Outcome, timestamp: string, error: string | null) {
    db.prepare(CLOSE_ATTEMPT).run(outcome, timestamp, error, messageId, attempt);
}
