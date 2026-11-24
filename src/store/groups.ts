import type { DatabaseSync } from 'node:sqlite';
import { CAMPAIGN_ID } from '../config/constants.js';
import { CampaignExistsError, NotFoundError } from '../errors.js';
import type { CampaignChannel } from '../types/index.js';
import { getCampaignSummary } from './campaigns.js';
import { nowIso, nullableText, toCampaignSummary, type CampaignSummary, type SqlRow } from './records.js';
import { PENDING_STATUSES, SENT_STATUSES } from './statuses.js';

export const CAMPAIGN_STATUS_FILTERS = ['queued', 'processing', 'completed', 'failed'] as const;
export type CampaignStatusFilter = typeof CAMPAIGN_STATUS_FILTERS[number];
export type ContactIdentity = 'row' | 'none';
export const CHANNEL_ORDER: readonly CampaignChannel[] = ['gmail', 'whatsapp'];

export interface SharedContent {
    script: string;
    scriptHtml?: string;
    subject: string;
    attachment: string;
}

export interface CampaignGroup {
    id: number;
    slug: string;
    name: string;
    contactIdentity: ContactIdentity;
    shared: SharedContent | null;
    pendingChannels: CampaignChannel[];
    createdAt: string;
    updatedAt: string;
}

export interface DeliveryMetrics {
    total: number;
    queued: number;
    processing: number;
    completed: number;
    delivered: number;
    read: number;
    failed: number;
    unknown: number;
    skipped: number;
}

export interface GroupMetrics extends DeliveryMetrics {
    people: number | null;
    peopleSent: number | null;
}

export interface GroupListing {
    slug: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    channels: CampaignChannel[];
    counts: DeliveryMetrics;
    members: CampaignSummary[];
}

export interface GroupQuery {
    status?: CampaignStatusFilter;
    channel?: CampaignChannel;
    page: number;
    pageSize: number;
}

export interface GroupPage {
    groups: GroupListing[];
    page: number;
    pageSize: number;
    totalPages: number;
    matching: number;
    allCampaigns: number;
    totals: Pick<DeliveryMetrics, 'queued' | 'processing' | 'completed' | 'failed' | 'unknown'>;
}

const COUNT_COLUMNS = `
    coalesce(sum(s.total), 0) AS total,
    coalesce(sum(s.total) FILTER (WHERE s.status IN ${PENDING_STATUSES}), 0) AS queued,
    coalesce(sum(s.total) FILTER (WHERE s.status = 'SENDING'), 0) AS processing,
    coalesce(sum(s.total) FILTER (WHERE s.status IN ${SENT_STATUSES}), 0) AS completed,
    coalesce(sum(s.total) FILTER (WHERE s.status IN ('DELIVERED', 'READ')), 0) AS delivered,
    coalesce(sum(s.total) FILTER (WHERE s.status = 'READ'), 0) AS read,
    coalesce(sum(s.total) FILTER (WHERE s.status = 'FAILED'), 0) AS failed,
    coalesce(sum(s.total) FILTER (WHERE s.status = 'UNKNOWN'), 0) AS unknown,
    coalesce(sum(s.total) FILTER (WHERE s.status = 'SKIPPED'), 0) AS skipped
`;
const METRIC_KEYS = ['total', 'queued', 'processing', 'completed', 'delivered', 'read', 'failed', 'unknown', 'skipped'] as const;
const STATUS_CONDITIONS: Record<CampaignStatusFilter, string> = {
    queued: 'queued > 0',
    processing: 'processing > 0',
    completed: 'completed > 0',
    failed: '(failed > 0 OR unknown > 0)',
};
const MEMBER_SUMMARY = `
    SELECT c.id, c.state, c.created_at, c.updated_at, c.is_test, c.channel, c.interrupted_at, c.group_id, ${COUNT_COLUMNS}
    FROM campaigns c LEFT JOIN campaign_status_counts s ON s.campaign_id = c.id
`;
const GROUP_PEOPLE = `
    SELECT count(DISTINCT m.row_number) FILTER (WHERE m.eligible = 1) AS people,
        count(DISTINCT m.row_number) FILTER (WHERE m.status IN ${SENT_STATUSES}) AS people_sent
    FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE c.group_id = ?
`;
const INSERT_GROUP = `
    INSERT INTO campaign_groups(slug, name, contact_identity, shared_script, shared_script_html, shared_subject, shared_attachment,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
export function createGroup(db: DatabaseSync, slug: string, name: string, identity: ContactIdentity, shared?: SharedContent): number {
    if (!CAMPAIGN_ID.test(slug)) throw new Error('Use 1–64 letters, numbers, hyphens, or underscores for the campaign link');
    if (db.prepare('SELECT 1 FROM campaign_groups WHERE slug = ?').get(slug)) throw new CampaignExistsError(`Campaign "${slug}" already exists`);
    const timestamp = nowIso();
    const result = db.prepare(INSERT_GROUP).run(slug, name, identity, shared?.script ?? null, shared?.scriptHtml ?? null,
        shared?.subject ?? null, shared?.attachment ?? null, timestamp, timestamp);
    return Number(result.lastInsertRowid);
}

export function findGroup(db: DatabaseSync, slug: string): CampaignGroup {
    const row = db.prepare('SELECT * FROM campaign_groups WHERE slug = ?').get(slug);
    if (!row) throw new NotFoundError(`Campaign "${slug}" does not exist`);
    return toGroup(row);
}

export function groupOfCampaign(db: DatabaseSync, campaignId: string): CampaignGroup | undefined {
    const row = db.prepare('SELECT g.* FROM campaign_groups g JOIN campaigns c ON c.group_id = g.id WHERE c.id = ?').get(campaignId);
    return row ? toGroup(row) : undefined;
}

export function groupMembers(db: DatabaseSync, groupId: number): CampaignSummary[] {
    const rows = db.prepare(`${MEMBER_SUMMARY} WHERE c.group_id = ? GROUP BY c.id`).all(groupId);
    return sortByChannel(rows.map(toCampaignSummary));
}

export function memberFor(db: DatabaseSync, group: CampaignGroup, channel: CampaignChannel): CampaignSummary {
    const row = db.prepare('SELECT id FROM campaigns WHERE group_id = ? AND channel = ?').get(group.id, channel);
    if (!row) throw new NotFoundError(`Campaign "${group.slug}" does not send with this channel`);
    return getCampaignSummary(db, String(row.id));
}

export function groupMetrics(db: DatabaseSync, group: CampaignGroup, members: readonly CampaignSummary[]): GroupMetrics {
    const counts = db.prepare(`SELECT ${COUNT_COLUMNS} FROM campaign_status_counts s JOIN campaigns c ON c.id = s.campaign_id WHERE c.group_id = ?`)
        .get(group.id);
    const metrics = toMetrics(counts);
    if (members.length === 1) return { ...metrics, people: members[0]!.total - members[0]!.skipped, peopleSent: metrics.completed };
    if (group.contactIdentity !== 'row') return { ...metrics, people: null, peopleSent: null };
    const people = db.prepare(GROUP_PEOPLE).get(group.id);
    return { ...metrics, people: Number(people?.people), peopleSent: Number(people?.people_sent) };
}

export function memberMetrics(db: DatabaseSync, campaignId: string): DeliveryMetrics {
    return toMetrics(db.prepare(`SELECT ${COUNT_COLUMNS} FROM campaign_status_counts s WHERE s.campaign_id = ?`).get(campaignId));
}

export function listGroupPage(db: DatabaseSync, query: GroupQuery): GroupPage {
    const channelClause = query.channel ? ' AND c.channel = ?' : '';
    const args = query.channel ? [query.channel] : [];
    const summary = `WITH member AS (${MEMBER_SUMMARY} WHERE c.group_id IS NOT NULL AND c.is_test = 0${channelClause} GROUP BY c.id),
        grouped AS (
            SELECT g.id AS group_id, g.slug, g.name, g.created_at, max(g.updated_at, max(m.updated_at)) AS updated_at,
                ${METRIC_KEYS.map(key => `sum(m.${key}) AS ${key}`).join(', ')}
            FROM campaign_groups g JOIN member m ON m.group_id = g.id GROUP BY g.id
        )`;
    const statusClause = query.status ? `WHERE ${STATUS_CONDITIONS[query.status]}` : '';
    const totals = db.prepare(`${summary}
        SELECT coalesce(sum(queued), 0) AS queued, coalesce(sum(processing), 0) AS processing, coalesce(sum(completed), 0) AS completed,
            coalesce(sum(failed), 0) AS failed, coalesce(sum(unknown), 0) AS unknown, (SELECT count(*) FROM grouped ${statusClause}) AS matching
        FROM grouped`).get(...args) as Record<string, number>;
    const allCampaigns = Number(db.prepare('SELECT count(*) AS n FROM campaign_groups g WHERE EXISTS (SELECT 1 FROM campaigns c WHERE c.group_id = g.id)')
        .get()?.n);
    const matching = Number(totals.matching);
    const totalPages = Math.max(1, Math.ceil(matching / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const rows = db.prepare(`${summary} SELECT * FROM grouped ${statusClause} ORDER BY created_at DESC, slug LIMIT ? OFFSET ?`)
        .all(...args, query.pageSize, (page - 1) * query.pageSize);
    const members = membersByGroup(db, rows.map(row => Number(row.group_id)));
    return {
        groups: rows.map(row => toListing(row, members.get(Number(row.group_id)) ?? [])),
        page, pageSize: query.pageSize, totalPages, matching, allCampaigns,
        totals: {
            queued: Number(totals.queued), processing: Number(totals.processing), completed: Number(totals.completed),
            failed: Number(totals.failed), unknown: Number(totals.unknown),
        },
    };
}

export function renameGroup(db: DatabaseSync, slug: string, name: string): CampaignGroup {
    const group = findGroup(db, slug);
    db.prepare('UPDATE campaign_groups SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), group.id);
    return findGroup(db, slug);
}

export function saveSharedContent(db: DatabaseSync, groupId: number, shared: SharedContent): void {
    db.prepare(`UPDATE campaign_groups SET shared_script = ?, shared_script_html = ?, shared_subject = ?, shared_attachment = ?, updated_at = ?
        WHERE id = ?`).run(shared.script, shared.scriptHtml ?? null, shared.subject, shared.attachment, nowIso(), groupId);
}

export function setPendingChannels(db: DatabaseSync, groupId: number, channels: readonly CampaignChannel[]): void {
    db.prepare('UPDATE campaign_groups SET pending_channels = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(channels), nowIso(), groupId);
}

export function deleteEmptyGroup(db: DatabaseSync, groupId: number): void {
    db.prepare('DELETE FROM campaign_groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM campaigns WHERE group_id = ?)').run(groupId, groupId);
}

function membersByGroup(db: DatabaseSync, groupIds: number[]): Map<number, CampaignSummary[]> {
    const grouped = new Map<number, CampaignSummary[]>();
    if (!groupIds.length) return grouped;
    const rows = db.prepare(`${MEMBER_SUMMARY} WHERE c.group_id IN (${groupIds.map(() => '?').join(', ')}) GROUP BY c.id`).all(...groupIds);
    for (const row of rows) {
        const id = Number(row.group_id);
        grouped.set(id, sortByChannel([...grouped.get(id) ?? [], toCampaignSummary(row)]));
    }
    return grouped;
}

function sortByChannel(members: CampaignSummary[]): CampaignSummary[] {
    return members.sort((a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel));
}

function toListing(row: SqlRow, members: CampaignSummary[]): GroupListing {
    return {
        slug: String(row.slug), name: String(row.name), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        channels: members.map(member => member.channel), counts: toMetrics(row), members,
    };
}

function toMetrics(row: SqlRow | undefined): DeliveryMetrics {
    return Object.fromEntries(METRIC_KEYS.map(key => [key, Number(row?.[key] ?? 0)])) as unknown as DeliveryMetrics;
}

function toGroup(row: SqlRow): CampaignGroup {
    const script = nullableText(row.shared_script);
    const html = nullableText(row.shared_script_html);
    const shared = script === null ? null : {
        script, subject: String(row.shared_subject ?? ''), attachment: String(row.shared_attachment ?? ''), ...(html ? { scriptHtml: html } : {}),
    };
    return {
        id: Number(row.id), slug: String(row.slug), name: String(row.name),
        contactIdentity: row.contact_identity === 'row' ? 'row' : 'none',
        shared, pendingChannels: readChannels(row.pending_channels),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
}

function readChannels(value: SqlRow[string] | undefined): CampaignChannel[] {
    try {
        const parsed: unknown = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? CHANNEL_ORDER.filter(channel => parsed.includes(channel)) : [];
    } catch {
        return [];
    }
}
