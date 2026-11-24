export const interruptedAtMigration = `
    ALTER TABLE campaigns ADD COLUMN interrupted_at TEXT;
`;
