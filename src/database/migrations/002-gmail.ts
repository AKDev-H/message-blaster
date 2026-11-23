export const gmailMigration = `
  ALTER TABLE campaigns ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'gmail'));
  ALTER TABLE messages RENAME COLUMN phone TO recipient;
  ALTER TABLE messages ADD COLUMN subject TEXT NOT NULL DEFAULT '';
  ALTER TABLE messages RENAME COLUMN whatsapp_message_id TO transport_message_id;
  ALTER TABLE message_attempts RENAME COLUMN whatsapp_message_id TO transport_message_id;
  CREATE TABLE recipient_withdrawals (
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'gmail')),
    recipient TEXT NOT NULL,
    withdrawn_at TEXT NOT NULL,
    PRIMARY KEY (channel, recipient)
  ) STRICT;
  INSERT INTO recipient_withdrawals(channel, recipient, withdrawn_at)
    SELECT 'whatsapp', phone, withdrawn_at FROM consent_withdrawals;
  DROP TABLE consent_withdrawals;
  ALTER TABLE recipient_withdrawals RENAME TO consent_withdrawals;
  DROP INDEX eligible_campaign_phone;
  CREATE UNIQUE INDEX eligible_campaign_recipient ON messages(campaign_id, recipient) WHERE eligible = 1;
`;
