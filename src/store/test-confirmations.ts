import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { ConflictError } from '../errors.js';
import { CAMPAIGN_CHANNEL_LABELS } from '../types/index.js';
import { getCampaign } from './campaigns.js';
import { nowIso, type Campaign } from './records.js';
import { SENT_STATUS_NAMES } from './statuses.js';

const SAVE_CONFIRMATION = `
    INSERT INTO confirmed_test(account_id, campaign_id, confirmed_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET campaign_id = excluded.campaign_id, confirmed_at = excluded.confirmed_at
`;

export function isConfirmedTestCampaign(db: DatabaseSync, id: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM confirmed_test WHERE campaign_id = ?').get(id));
}

export function hasConfirmedTest(db: DatabaseSync, accountId: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM confirmed_test WHERE account_id = ?').get(accountId));
}

export function confirmTest(db: DatabaseSync, id: string, accountId?: string): void {
    transaction(db, () => {
        const campaign = getCampaign(db, id);
        ensureConfirmable(db, campaign, accountId);
        db.prepare(SAVE_CONFIRMATION).run(campaign.accountId, id, nowIso());
    });
}

function ensureConfirmable(db: DatabaseSync, campaign: Campaign, accountId: string | undefined): void {
    if (!campaign.isTest) throw new ConflictError('Use a registered single-contact test campaign for confirmation');
    if (!campaign.accountId || (accountId !== undefined && campaign.accountId !== accountId)) {
        throw new Error(`Test confirmation requires the ${CAMPAIGN_CHANNEL_LABELS[campaign.channel]} account used for the send`);
    }
    if (!sentExactlyOneMessage(db, campaign.id)) throw new Error('Test confirmation requires one successfully submitted test message');
}

function sentExactlyOneMessage(db: DatabaseSync, id: string): boolean {
    const eligible = db.prepare('SELECT status FROM messages WHERE campaign_id = ? AND eligible = 1').all(id);
    return eligible.length === 1 && SENT_STATUS_NAMES.includes(String(eligible[0]?.status));
}
