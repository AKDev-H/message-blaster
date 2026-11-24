// One dashboard campaign ("group") owns one channel campaign per channel. Existing campaigns
// keep their IDs, messages, attempts and receipts; each non-test campaign is backfilled into
// its own group whose slug is the campaign ID. Split Gmail/WhatsApp pairs are only merged
// after an operator confirms them with `campaign:group`.
export const campaignGroupsMigration = `
    CREATE TABLE campaign_groups (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        contact_identity TEXT NOT NULL DEFAULT 'none' CHECK (contact_identity IN ('row', 'none')),
        shared_script TEXT,
        shared_script_html TEXT,
        shared_subject TEXT,
        shared_attachment TEXT,
        pending_channels TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT;

    ALTER TABLE campaigns ADD COLUMN group_id INTEGER REFERENCES campaign_groups(id);
    CREATE UNIQUE INDEX campaign_group_channel ON campaigns(group_id, channel) WHERE group_id IS NOT NULL;

    ALTER TABLE web_campaign_drafts ADD COLUMN overrides TEXT NOT NULL DEFAULT '[]';

    INSERT INTO campaign_groups(slug, name, contact_identity, created_at, updated_at)
        SELECT id, id, 'row', created_at, updated_at FROM campaigns WHERE is_test = 0 ORDER BY created_at, rowid;
    UPDATE campaigns SET group_id = (SELECT g.id FROM campaign_groups g WHERE g.slug = campaigns.id) WHERE is_test = 0;
`;
