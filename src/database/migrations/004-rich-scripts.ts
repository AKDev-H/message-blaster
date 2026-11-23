export const richScriptsMigration = `
    ALTER TABLE web_campaign_drafts ADD COLUMN script_html TEXT;
    ALTER TABLE messages ADD COLUMN message_html TEXT;
`;
