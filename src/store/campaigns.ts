import type { DatabaseSync } from 'node:sqlite';
import { CampaignExistsError, NotFoundError } from '../errors.js';
import type { CampaignChannel, CampaignState } from '../types/index.js';
import { nowIso, toCampaign, toCampaignSummary, type Campaign, type CampaignSummary } from './records.js';
import { PENDING_STATUSES, SENT_STATUSES } from './statuses.js';

const INSERT_CAMPAIGN = `
    INSERT INTO campaigns(id, state, is_test, created_at, updated_at, channel, group_id) VALUES (?, 'Draft', ?, ?, ?, ?, ?)
`;
const SUMMARY = `
    SELECT c.id, c.state, c.created_at, c.updated_at, c.is_test, c.channel, c.interrupted_at,
        coalesce(sum(s.total), 0) AS total,
        coalesce(sum(s.total) FILTER (WHERE s.status IN ${PENDING_STATUSES}), 0) AS queued,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'SENDING'), 0) AS processing,
        coalesce(sum(s.total) FILTER (WHERE s.status IN ${SENT_STATUSES}), 0) AS completed,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'FAILED'), 0) AS failed,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'UNKNOWN'), 0) AS unknown,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'SKIPPED'), 0) AS skipped
    FROM campaigns c LEFT JOIN campaign_status_counts s ON s.campaign_id = c.id
`;
const SET_STATE = `
    UPDATE campaigns SET state = ?, updated_at = ?, interrupted_at = CASE WHEN ? = 'Running' THEN NULL ELSE interrupted_at END WHERE id = ?
`;
const LATEST_TEST = `
    SELECT * FROM campaigns WHERE is_test = 1 AND channel = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
`;
const DELETE_CAMPAIGN = [
    'DELETE FROM confirmed_test WHERE campaign_id = ?',
    'DELETE FROM message_attempts WHERE message_id IN (SELECT id FROM messages WHERE campaign_id = ?)',
    'DELETE FROM messages WHERE campaign_id = ?',
    'DELETE FROM campaigns WHERE id = ?',
];

export function insertCampaign(db: DatabaseSync, id: string, isTest: boolean, channel: CampaignChannel, groupId: number | null = null): void {
    if (db.prepare('SELECT id FROM campaigns WHERE id = ?').get(id)) throw new CampaignExistsError(`Campaign "${id}" already exists`);
    const timestamp = nowIso();
    db.prepare(INSERT_CAMPAIGN).run(id, Number(isTest), timestamp, timestamp, channel, groupId);
}

export function getCampaign(db: DatabaseSync, id: string): Campaign {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`Campaign "${id}" does not exist`);
    return toCampaign(row);
}

export function getCampaignSummary(db: DatabaseSync, id: string): CampaignSummary {
    const row = db.prepare(`${SUMMARY} WHERE c.id = ? GROUP BY c.id`).get(id);
    if (!row) throw new NotFoundError(`Campaign "${id}" does not exist`);
    return toCampaignSummary(row);
}

export function listActiveCampaignIds(db: DatabaseSync): string[] {
    const rows = db.prepare(`SELECT c.id FROM campaigns c WHERE c.state = 'Running'
        OR EXISTS (SELECT 1 FROM campaign_status_counts s WHERE s.campaign_id = c.id AND s.status = 'SENDING' AND s.total > 0)`).all();
    return rows.map(row => String(row.id));
}

export function latestTestCampaign(db: DatabaseSync, channel: CampaignChannel): Campaign | undefined {
    const row = db.prepare(LATEST_TEST).get(channel);
    return row ? toCampaign(row) : undefined;
}

export function setState(db: DatabaseSync, id: string, state: CampaignState): Campaign {
    db.prepare(SET_STATE).run(state, nowIso(), state, id);
    return getCampaign(db, id);
}

export function markInterrupted(db: DatabaseSync, id: string): void {
    db.prepare("UPDATE campaigns SET interrupted_at = ? WHERE id = ? AND state = 'Paused'").run(nowIso(), id);
}

export function saveAccount(db: DatabaseSync, id: string, accountId: string): void {
    db.prepare('UPDATE campaigns SET account_id = ? WHERE id = ?').run(accountId, id);
}

export function removeCampaign(db: DatabaseSync, id: string): void {
    for (const sql of DELETE_CAMPAIGN) db.prepare(sql).run(id);
}
