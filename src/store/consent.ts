import type { DatabaseSync } from 'node:sqlite';
import type { CampaignChannel } from '../types/index.js';
import { nowIso } from './records.js';
import { PENDING_STATUSES, WITHDRAWAL_ERROR } from './statuses.js';

const RECORD_WITHDRAWAL = `
    INSERT INTO consent_withdrawals(recipient, withdrawn_at, channel) VALUES (?, ?, ?) ON CONFLICT(channel, recipient) DO NOTHING
`;
const SKIP_QUEUED_MESSAGES = `
    UPDATE messages SET status = 'SKIPPED', error_message = ?
    WHERE recipient = ? AND campaign_id IN (SELECT id FROM campaigns WHERE channel = ?) AND status IN ${PENDING_STATUSES}
`;
const IS_WITHDRAWN = 'SELECT 1 FROM consent_withdrawals WHERE recipient = ? AND channel = ?';

export function withdrawConsent(db: DatabaseSync, recipient: string, channel: CampaignChannel): number {
    db.prepare(RECORD_WITHDRAWAL).run(recipient, nowIso(), channel);
    return Number(db.prepare(SKIP_QUEUED_MESSAGES).run(WITHDRAWAL_ERROR, recipient, channel).changes);
}

export function isWithdrawn(db: DatabaseSync, recipient: string, channel: CampaignChannel): boolean {
    return Boolean(db.prepare(IS_WITHDRAWN).get(recipient, channel));
}

export function withdrawalChecker(db: DatabaseSync, channel: CampaignChannel): (recipient: string) => boolean {
    const statement = db.prepare(IS_WITHDRAWN);
    return recipient => Boolean(statement.get(recipient, channel));
}
