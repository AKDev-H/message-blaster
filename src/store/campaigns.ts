import type { DatabaseSync } from 'node:sqlite';
import { CampaignExistsError, NotFoundError } from '../errors.js';
import type { CampaignChannel, CampaignState } from '../types/index.js';
import { nowIso, toCampaign, toCampaignSummary, type Campaign, type CampaignSummary } from './records.js';
import { PENDING_STATUSES, SENT_STATUSES } from './statuses.js';

const INSERT_CAMPAIGN = `
    INSERT INTO campaigns(id, state, is_test, created_at, updated_at, channel, group_id) VALUES (?, 'Draft', ?, ?, ?, ?, ?)
`;
const SUMMARY = `
    SELECT c.id, c.state, c.created_at, c.updated_at, c.is_test, c.channel,
        coalesce(sum(s.total), 0) AS total,
        coalesce(sum(s.total) FILTER (WHERE s.status IN ${PENDING_STATUSES}), 0) AS queued,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'SENDING'), 0) AS processing,
        coalesce(sum(s.total) FILTER (WHERE s.status IN ${SENT_STATUSES}), 0) AS completed,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'FAILED'), 0) AS failed,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'UNKNOWN'), 0) AS unknown,
        coalesce(sum(s.total) FILTER (WHERE s.status = 'SKIPPED'), 0) AS skipped
    FROM campaigns c LEFT JOIN campaign_status_counts s ON s.campaign_id = c.id
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

export function listCampaignSummaries(db: DatabaseSync): CampaignSummary[] {
    return db.prepare(`${SUMMARY} GROUP BY c.id ORDER BY c.created_at DESC, c.id`).all().map(toCampaignSummary);
}

export const CAMPAIGN_STATUS_FILTERS = ['queued', 'processing', 'completed', 'failed'] as const;
export type CampaignStatusFilter = typeof CAMPAIGN_STATUS_FILTERS[number];

export interface CampaignQuery {
    status?: CampaignStatusFilter;
    channel?: CampaignChannel;
    page: number;
    pageSize: number;
}

export interface CampaignTotals {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    unknown: number;
}

export interface CampaignPage {
    campaigns: CampaignSummary[];
    page: number;
    pageSize: number;
    totalPages: number;
    matching: number;
    allCampaigns: number;
    totals: CampaignTotals;
}

const STATUS_CONDITIONS: Record<CampaignStatusFilter, string> = {
    queued: 'queued > 0',
    processing: 'processing > 0',
    completed: 'completed > 0',
    failed: '(failed > 0 OR unknown > 0)',
};

export function listCampaignPage(db: DatabaseSync, query: CampaignQuery): CampaignPage {
    const channelClause = query.channel ? ' AND c.channel = ?' : '';
    const channelArgs = query.channel ? [query.channel] : [];
    const filtered = `WITH summary AS (${SUMMARY} WHERE c.is_test = 0${channelClause} GROUP BY c.id)`;
    const statusClause = query.status ? `WHERE ${STATUS_CONDITIONS[query.status]}` : '';
    const totals = db.prepare(`${filtered}
        SELECT count(*) AS campaigns,
            coalesce(sum(queued), 0) AS queued, coalesce(sum(processing), 0) AS processing,
            coalesce(sum(completed), 0) AS completed, coalesce(sum(failed), 0) AS failed, coalesce(sum(unknown), 0) AS unknown,
            (SELECT count(*) FROM summary ${statusClause}) AS matching
        FROM summary`).get(...channelArgs) as Record<string, number>;
    const allCampaigns = Number((db.prepare('SELECT count(*) AS n FROM campaigns WHERE is_test = 0').get() as { n: number }).n);
    const matching = Number(totals.matching);
    const totalPages = Math.max(1, Math.ceil(matching / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const rows = db.prepare(`${filtered} SELECT * FROM summary ${statusClause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
        .all(...channelArgs, query.pageSize, (page - 1) * query.pageSize);
    return {
        campaigns: rows.map(toCampaignSummary),
        page, pageSize: query.pageSize, totalPages, matching, allCampaigns,
        totals: {
            queued: Number(totals.queued), processing: Number(totals.processing), completed: Number(totals.completed),
            failed: Number(totals.failed), unknown: Number(totals.unknown),
        },
    };
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
    db.prepare('UPDATE campaigns SET state = ?, updated_at = ? WHERE id = ?').run(state, nowIso(), id);
    return getCampaign(db, id);
}

export function saveAccount(db: DatabaseSync, id: string, accountId: string): void {
    db.prepare('UPDATE campaigns SET account_id = ? WHERE id = ?').run(accountId, id);
}

export function removeCampaign(db: DatabaseSync, id: string): void {
    const groupId = db.prepare('SELECT group_id FROM campaigns WHERE id = ?').get(id)?.group_id;
    for (const sql of DELETE_CAMPAIGN) db.prepare(sql).run(id);
    if (typeof groupId === 'number') {
        db.prepare('DELETE FROM campaign_groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM campaigns WHERE group_id = ?)').run(groupId, groupId);
    }
}
