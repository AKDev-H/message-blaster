import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { ConflictError } from '../errors.js';
import { getCampaign, setState } from './campaigns.js';
import { deleteRecipients, insertRecipients } from './recipients.js';
import { toWebDraftSettings, type Campaign, type PreparedRow, type WebDraft, type WebDraftSettings } from './records.js';

const SAVE_DRAFT = `
    INSERT INTO web_campaign_drafts(campaign_id, workbook, script, subject, attachment, script_html) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id) DO UPDATE SET workbook = excluded.workbook, script = excluded.script,
        subject = excluded.subject, attachment = excluded.attachment, script_html = excluded.script_html
`;
const DRAFT = 'SELECT workbook, script, subject, attachment, script_html FROM web_campaign_drafts WHERE campaign_id = ?';
const DRAFT_SETTINGS = 'SELECT script, subject, attachment, script_html FROM web_campaign_drafts WHERE campaign_id = ?';
const HAS_ATTEMPTS = 'SELECT 1 FROM messages WHERE campaign_id = ? AND attempt_count > 0 LIMIT 1';

export function saveWebDraft(db: DatabaseSync, id: string, draft: WebDraft): void {
    db.prepare(SAVE_DRAFT).run(id, draft.workbook, draft.script, draft.subject, draft.attachment, draft.scriptHtml ?? null);
}

export function getWebDraft(db: DatabaseSync, id: string): WebDraft | null {
    const row = db.prepare(DRAFT).get(id);
    if (!row) return null;
    if (!(row.workbook instanceof Uint8Array)) throw new Error('The imported workbook is unavailable');
    return { ...toWebDraftSettings(row), workbook: Buffer.from(row.workbook) };
}

export function getWebDraftSettings(db: DatabaseSync, id: string): WebDraftSettings | null {
    const row = db.prepare(DRAFT_SETTINGS).get(id);
    return row ? toWebDraftSettings(row) : null;
}

export function replaceWebDraft(db: DatabaseSync, id: string, rows: PreparedRow[], draft: WebDraft): Campaign {
    return transaction(db, () => {
        const campaign = getCampaign(db, id);
        ensureDraftIsEditable(db, campaign);
        deleteRecipients(db, id);
        saveWebDraft(db, id, draft);
        const hasEligible = insertRecipients(db, id, campaign.channel, campaign.isTest, rows);
        return setState(db, id, hasEligible ? 'Ready' : 'Draft');
    });
}

function ensureDraftIsEditable(db: DatabaseSync, campaign: Campaign): void {
    const neverStarted = !campaign.accountId && ['Draft', 'Ready'].includes(campaign.state);
    if (!neverStarted || !getWebDraftSettings(db, campaign.id)) throw new ConflictError('Only a web draft that has never started can be edited');
    if (db.prepare(HAS_ATTEMPTS).get(campaign.id)) throw new ConflictError('Cannot edit a campaign that already has delivery attempts');
}
