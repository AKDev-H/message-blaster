export const webMigration = `
    CREATE TABLE web_campaign_drafts (
        campaign_id TEXT PRIMARY KEY NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        workbook BLOB NOT NULL,
        script TEXT NOT NULL,
        subject TEXT NOT NULL,
        attachment TEXT NOT NULL
    ) STRICT;

    CREATE TABLE campaign_status_counts (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        total INTEGER NOT NULL CHECK(total >= 0),
        PRIMARY KEY (campaign_id, status)
    ) STRICT;

    INSERT INTO campaign_status_counts(campaign_id, status, total)
        SELECT campaign_id, status, count(*) FROM messages GROUP BY campaign_id, status;

    CREATE TRIGGER count_inserted_message AFTER INSERT ON messages BEGIN
        INSERT INTO campaign_status_counts(campaign_id, status, total) VALUES (NEW.campaign_id, NEW.status, 1)
        ON CONFLICT(campaign_id, status) DO UPDATE SET total = total + 1;
    END;

    CREATE TRIGGER count_updated_message AFTER UPDATE OF status ON messages WHEN NEW.status <> OLD.status BEGIN
        UPDATE campaign_status_counts SET total = total - 1 WHERE campaign_id = OLD.campaign_id AND status = OLD.status;
        INSERT INTO campaign_status_counts(campaign_id, status, total) VALUES (NEW.campaign_id, NEW.status, 1)
        ON CONFLICT(campaign_id, status) DO UPDATE SET total = total + 1;
        UPDATE campaigns SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.campaign_id;
    END;

    CREATE TRIGGER count_deleted_message AFTER DELETE ON messages BEGIN
        UPDATE campaign_status_counts SET total = total - 1 WHERE campaign_id = OLD.campaign_id AND status = OLD.status;
    END;
`;
