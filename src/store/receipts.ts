import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import type { ReceiptStage } from '../types/index.js';
import { nowIso } from './records.js';
import { FAULT_STATUSES, PENDING_STATUSES, SENT_STATUSES } from './statuses.js';

const WHATSAPP_MESSAGE = "transport_message_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'whatsapp')";
const MARK_REJECTED = `
    UPDATE messages SET status = 'UNKNOWN', error_message = 'WhatsApp reported a send error. Review the outcome.'
    WHERE ${WHATSAPP_MESSAGE} AND status IN ('SENDING', 'SENT', 'QUEUED') AND acknowledged_at IS NULL
`;
const RECORD_STAGE = `
    UPDATE messages SET
        status = CASE
            WHEN status = 'READ' OR :stage = 'READ' THEN 'READ'
            WHEN status = 'DELIVERED' OR :stage = 'DELIVERED' THEN 'DELIVERED'
            ELSE 'SENT'
        END,
        sent_at = coalesce(sent_at, :now),
        acknowledged_at = CASE WHEN :stage = 'ACKNOWLEDGED' THEN coalesce(acknowledged_at, :now) ELSE acknowledged_at END,
        delivered_at = CASE WHEN :stage = 'DELIVERED' THEN coalesce(delivered_at, :now) ELSE delivered_at END,
        read_at = CASE WHEN :stage = 'READ' THEN coalesce(read_at, :now) ELSE read_at END,
        error_message = NULL
    WHERE transport_message_id = :id AND campaign_id IN (SELECT id FROM campaigns WHERE channel = 'whatsapp')
`;

const CRASH_ERROR = 'Interrupted during an attempt. Review the delivery outcome.';
const MARK_INTERRUPTED_MESSAGES = "UPDATE messages SET status = 'UNKNOWN', error_message = ? WHERE status = 'SENDING'";
const CLOSE_INTERRUPTED_ATTEMPTS = `
    UPDATE message_attempts SET
        state = CASE WHEN messages.status IN ${SENT_STATUSES} THEN 'SENT' ELSE 'UNKNOWN' END,
        finished_at = ?,
        error_message = CASE WHEN messages.status IN ${SENT_STATUSES} THEN NULL ELSE coalesce(messages.error_message, ?) END
    FROM messages WHERE message_attempts.message_id = messages.id AND message_attempts.state = 'SENDING'
`;
const has = (statuses: string) => `EXISTS(SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status IN ${statuses})`;
const SETTLE_INTERRUPTED_CAMPAIGNS = `
    UPDATE campaigns SET state = CASE
        WHEN ${has(PENDING_STATUSES)} THEN 'Paused'
        WHEN ${has(SENT_STATUSES)} THEN 'Completed'
        WHEN ${has(FAULT_STATUSES)} THEN 'Failed'
        ELSE 'Completed'
    END, updated_at = ?
    WHERE state = 'Running' OR (state = 'Paused' AND NOT ${has(PENDING_STATUSES)})
`;

const FLAG_INTERRUPTED_CAMPAIGNS = `UPDATE campaigns SET interrupted_at = ? WHERE state = 'Running' AND ${has(PENDING_STATUSES)}`;

export function recordReceipt(db: DatabaseSync, whatsappId: string, stage: ReceiptStage): void {
    if (stage === 'REJECTED') db.prepare(MARK_REJECTED).run(whatsappId);
    else db.prepare(RECORD_STAGE).run({ stage, now: nowIso(), id: whatsappId });
}

export function recoverInterrupted(db: DatabaseSync): number {
    return transaction(db, () => {
        const timestamp = nowIso();
        const interrupted = db.prepare(MARK_INTERRUPTED_MESSAGES).run(CRASH_ERROR);
        db.prepare(FLAG_INTERRUPTED_CAMPAIGNS).run(timestamp);
        db.prepare(CLOSE_INTERRUPTED_ATTEMPTS).run(timestamp, CRASH_ERROR);
        db.prepare(SETTLE_INTERRUPTED_CAMPAIGNS).run(timestamp);
        return Number(interrupted.changes);
    });
}
