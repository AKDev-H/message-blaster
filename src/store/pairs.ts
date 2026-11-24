import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { createGroup, deleteEmptyGroup, findGroup, groupOfCampaign, type CampaignGroup } from './groups.js';

export interface PairEvidence {
    sameWorkbook: boolean;
    createdTogether: boolean;
}

export interface PairCandidate extends PairEvidence {
    slug: string;
    gmail: string;
    whatsapp: string;
    slugAvailable: boolean;
}

const SINGLE_CHANNEL = (alias: string) => `(SELECT count(*) FROM campaigns c WHERE c.group_id = ${alias}.group_id) = 1`;
const SPLIT_PAIRS = `
    SELECT gm.id AS gmail, wa.id AS whatsapp, substr(gm.id, 1, length(gm.id) - 6) AS slug
    FROM campaigns gm JOIN campaigns wa ON wa.id = substr(gm.id, 1, length(gm.id) - 6) || '-whatsapp'
    WHERE gm.id LIKE '%-gmail' AND gm.channel = 'gmail' AND wa.channel = 'whatsapp' AND gm.is_test = 0 AND wa.is_test = 0
        AND ${SINGLE_CHANNEL('gm')} AND ${SINGLE_CHANNEL('wa')}
    ORDER BY gm.created_at, gm.id
`;
const EVIDENCE = `
    SELECT coalesce(gd.workbook = wd.workbook, 0) AS same_workbook,
        abs(julianday(gm.created_at) - julianday(wa.created_at)) * 86400 < 5 AS created_together
    FROM campaigns gm JOIN campaigns wa ON wa.id = :whatsapp
    LEFT JOIN web_campaign_drafts gd ON gd.campaign_id = gm.id
    LEFT JOIN web_campaign_drafts wd ON wd.campaign_id = wa.id
    WHERE gm.id = :gmail AND gm.channel = 'gmail' AND wa.channel = 'whatsapp' AND gm.is_test = 0 AND wa.is_test = 0
`;

export function pairCandidates(db: DatabaseSync): PairCandidate[] {
    return db.prepare(SPLIT_PAIRS).all().map(row => {
        const gmail = String(row.gmail);
        const whatsapp = String(row.whatsapp);
        const slug = String(row.slug);
        return { slug, gmail, whatsapp, ...pairEvidence(db, gmail, whatsapp), slugAvailable: !db.prepare('SELECT 1 FROM campaign_groups WHERE slug = ?').get(slug) };
    });
}

export function mergePair(db: DatabaseSync, gmail: string, whatsapp: string, slug: string, force: boolean): CampaignGroup {
    return transaction(db, () => {
        const evidence = pairEvidence(db, gmail, whatsapp);
        if (!force && !evidence.sameWorkbook && !evidence.createdTogether) {
            throw new ConflictError('No evidence links these campaigns: they were not created together from the same workbook. Pass --force after checking them.');
        }
        const previous = [gmail, whatsapp].map(id => singleChannelGroup(db, id));
        const groupId = createGroup(db, slug, slug, evidence.sameWorkbook ? 'row' : 'none');
        const createdAt = previous.map(group => group.createdAt).sort()[0]!;
        db.prepare('UPDATE campaign_groups SET created_at = ? WHERE id = ?').run(createdAt, groupId);
        db.prepare('UPDATE campaigns SET group_id = ? WHERE id IN (?, ?)').run(groupId, gmail, whatsapp);
        for (const group of previous) deleteEmptyGroup(db, group.id);
        return findGroup(db, slug);
    });
}

function pairEvidence(db: DatabaseSync, gmail: string, whatsapp: string): PairEvidence {
    const row = db.prepare(EVIDENCE).get({ gmail, whatsapp });
    if (!row) throw new NotFoundError('Choose an existing Gmail campaign and an existing WhatsApp campaign');
    return { sameWorkbook: row.same_workbook === 1, createdTogether: row.created_together === 1 };
}

function singleChannelGroup(db: DatabaseSync, id: string): CampaignGroup {
    const group = groupOfCampaign(db, id);
    if (!group) throw new NotFoundError(`${id} is not listed in the dashboard`);
    const members = Number(db.prepare('SELECT count(*) AS n FROM campaigns WHERE group_id = ?').get(group.id)?.n);
    if (members !== 1) throw new ConflictError(`${id} already belongs to a campaign with another channel`);
    return group;
}
