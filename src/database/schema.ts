import type { DatabaseSync } from 'node:sqlite';
import { initialMigration } from './migrations/001-initial.js';
import { gmailMigration } from './migrations/002-gmail.js';
import { webMigration } from './migrations/003-web.js';
import { richScriptsMigration } from './migrations/004-rich-scripts.js';
import { settingsMigration } from './migrations/005-settings.js';
import { dropClientIdMigration } from './migrations/006-drop-client-id.js';
import { transaction } from './transaction.js';

const migrations = [initialMigration, gmailMigration, webMigration, richScriptsMigration, settingsMigration, dropClientIdMigration];
const latestVersion = migrations.length;

export function migrate(db: DatabaseSync): void {
    if (schemaVersion(db) === latestVersion) return;
    transaction(db, () => applyPendingMigrations(db));
}

function applyPendingMigrations(db: DatabaseSync): void {
    const version = schemaVersion(db);
    if (version > latestVersion) throw new Error(`Database schema version ${version} is newer than this application supports`);
    for (const sql of migrations.slice(version)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${latestVersion}`);
}

function schemaVersion(db: DatabaseSync): number {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version);
}
