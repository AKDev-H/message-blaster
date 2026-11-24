import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { ConflictError } from '../errors.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignState } from '../types/index.js';
import { getCampaign, removeCampaign, saveAccount, setState } from './campaigns.js';
import { deleteEmptyGroup, groupOfCampaign } from './groups.js';
import type { Campaign } from './records.js';
import { CANCELLED_ERROR, FAULT_STATUSES, PENDING_STATUSES, SENT_STATUSES, UNFINISHED_STATUSES } from './statuses.js';

const HAS_PENDING = `SELECT 1 FROM messages WHERE campaign_id = ? AND status IN ${PENDING_STATUSES} LIMIT 1`;
const QUEUE_PENDING = "UPDATE messages SET status = 'QUEUED' WHERE campaign_id = ? AND status = 'PENDING'";
const SKIP_PENDING = `
    UPDATE messages SET status = 'SKIPPED', error_message = '${CANCELLED_ERROR}'
    WHERE campaign_id = ? AND status IN ${PENDING_STATUSES}
`;
const REQUEUE_FAILED = `
    UPDATE messages SET status = 'QUEUED', retry_at = 0, error_message = NULL
    WHERE campaign_id = ? AND status = 'FAILED' AND eligible = 1
        AND NOT EXISTS (SELECT 1 FROM consent_withdrawals WHERE recipient = messages.recipient AND channel = ?)
`;
const HAS_ACTIVE_ATTEMPTS = `
    SELECT 1 FROM messages m WHERE m.campaign_id = ? AND (
        m.status = 'SENDING' OR EXISTS (SELECT 1 FROM message_attempts a WHERE a.message_id = m.id AND a.state = 'SENDING')
    ) LIMIT 1
`;
const OUTCOME_COUNTS = `
    SELECT count(*) FILTER (WHERE status IN ${UNFINISHED_STATUSES}) AS pending_count,
        count(*) FILTER (WHERE status IN ${FAULT_STATUSES}) AS failed_count,
        count(*) FILTER (WHERE status IN ${SENT_STATUSES}) AS sent_count
    FROM messages WHERE campaign_id = ?
`;

export function activateCampaign(db: DatabaseSync, id: string, allowed: readonly CampaignState[]): Campaign {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        if (!allowed.includes(campaign.state)) throw new ConflictError(`Campaign "${id}" is ${campaign.state}. Expected ${allowed.join(' or ')}`);
        if (!db.prepare(HAS_PENDING).get(id)) throw new ConflictError('Campaign has no eligible pending messages');
        db.prepare(QUEUE_PENDING).run(id);
        return setState(db, id, 'Running');
    });
}

export function pauseCampaign(db: DatabaseSync, id: string): Campaign {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        if (campaign.state === 'Paused') return campaign;
        if (campaign.state !== 'Running') throw new ConflictError(`Cannot pause a ${campaign.state} campaign`);
        return setState(db, id, 'Paused');
    });
}

export function leaveRunning(db: DatabaseSync, id: string, next: CampaignState): Campaign {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        return campaign.state === 'Running' ? setState(db, id, next) : campaign;
    });
}

export function cancelCampaign(db: DatabaseSync, id: string): Campaign {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        if (campaign.state === 'Cancelled') return campaign;
        if (campaign.state === 'Completed') throw new ConflictError('Cannot cancel a completed campaign');
        db.prepare(SKIP_PENDING).run(id);
        return setState(db, id, 'Cancelled');
    });
}

export function retryFailedMessages(db: DatabaseSync, id: string): number {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        if (!['Paused', 'Completed', 'Failed'].includes(campaign.state) || hasActiveAttempts(db, id)) {
            throw new ConflictError('Cannot retry until the campaign is paused or finished and any in-flight attempts settle');
        }
        const requeued = Number(db.prepare(REQUEUE_FAILED).run(id, campaign.channel).changes);
        if (requeued) setState(db, id, 'Paused');
        return requeued;
    });
}

export function deleteCampaign(db: DatabaseSync, id: string): void {
    transaction(db, () => {
        const campaign = getCampaign(db, id);
        if (campaign.state === 'Running' || hasActiveAttempts(db, id)) {
            throw new ConflictError('Cannot delete until the campaign stops and any in-flight attempts settle');
        }
        const group = groupOfCampaign(db, id);
        removeCampaign(db, id);
        if (group) deleteEmptyGroup(db, group.id);
    });
}

export function settleCampaign(db: DatabaseSync, id: string): Campaign {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        if (campaign.state !== 'Running' && campaign.state !== 'Paused') return campaign;
        const counts = db.prepare(OUTCOME_COUNTS).get(id);
        if (counts?.pending_count !== 0) return campaign;
        const nothingSent = Number(counts.failed_count) > 0 && counts.sent_count === 0;
        return setState(db, id, nothingSent ? 'Failed' : 'Completed');
    });
}

export function bindAccount(db: DatabaseSync, id: string, accountId: string): void {
    transaction(db, () => {
        const campaign = getCampaign(db, id);
        const label = CAMPAIGN_CHANNEL_LABELS[campaign.channel];
        if (!accountId) throw new Error(`${label} account identity is unavailable`);
        if (campaign.accountId !== null && campaign.accountId !== accountId) throw new ConflictError(`Campaign is bound to a different ${label} account`);
        saveAccount(db, id, accountId);
    });
}

function hasActiveAttempts(db: DatabaseSync, id: string): boolean {
    return Boolean(db.prepare(HAS_ACTIVE_ATTEMPTS).get(id));
}
