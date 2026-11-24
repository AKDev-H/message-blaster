import type { DatabaseSync } from 'node:sqlite';
import { ConflictError } from '../errors.js';
import { getCampaign } from './campaigns.js';
import { nowIso, toAttemptRecord, type AttemptRecord } from './records.js';

export type ReviewResolution = 'SENT' | 'FAILED';

const RESOLVE_UNKNOWN = `
    UPDATE messages SET status = :resolution,
        sent_at = CASE WHEN :resolution = 'SENT' THEN coalesce(sent_at, :now) ELSE sent_at END,
        error_message = CASE WHEN :resolution = 'SENT' THEN NULL ELSE error_message END,
        reviewed_at = :now, review_note = :note
    WHERE id = :id AND (:campaign IS NULL OR campaign_id = :campaign) AND status = 'UNKNOWN' AND NOT EXISTS (
        SELECT 1 FROM message_attempts a WHERE a.message_id = messages.id AND a.state = 'SENDING'
    )
`;
const CAMPAIGN_ATTEMPTS = `
    SELECT a.* FROM message_attempts a JOIN messages m ON m.id = a.message_id
    WHERE m.campaign_id = ? ORDER BY m.row_number, a.attempt_number
`;

export function reviewMessage(db: DatabaseSync, messageId: number, resolution: ReviewResolution, note: string, campaignId?: string): void {
    if (!note.trim()) throw new Error('A review note is required');
    const values = { resolution, now: nowIso(), note, id: messageId, campaign: campaignId ?? null };
    const result = db.prepare(RESOLVE_UNKNOWN).run(values);
    if (result.changes === 0) throw new ConflictError('Only messages with unknown outcomes can be reviewed');
}

export function messageAttempts(db: DatabaseSync, messageId: number): AttemptRecord[] {
    return db.prepare('SELECT * FROM message_attempts WHERE message_id = ? ORDER BY attempt_number').all(messageId).map(toAttemptRecord);
}

export function campaignAttempts(db: DatabaseSync, id: string): AttemptRecord[] {
    getCampaign(db, id);
    return db.prepare(CAMPAIGN_ATTEMPTS).all(id).map(toAttemptRecord);
}
