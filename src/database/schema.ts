import type { DatabaseSync } from 'node:sqlite';
import { initialMigration } from './migrations/001-initial.js';
import { gmailMigration } from './migrations/002-gmail.js';
import { webMigration } from './migrations/003-web.js';
import { richScriptsMigration } from './migrations/004-rich-scripts.js';
import { settingsMigration } from './migrations/005-settings.js';
import { dropClientIdMigration } from './migrations/006-drop-client-id.js';

const migrations = [initialMigration, gmailMigration, webMigration, richScriptsMigration, settingsMigration, dropClientIdMigration];

function getVersion(db: DatabaseSync): number {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version);
}

export function migrate(db: DatabaseSync): void {
    if (getVersion(db) === migrations.length) return;

    db.exec('BEGIN IMMEDIATE');
    try {
        const version = getVersion(db);
        if (version > migrations.length) {
            throw new Error(`Database schema version ${version} is newer than this application supports`);
        }
        for (const [index, sql] of migrations.entries()) {
            if (index >= version) db.exec(sql);
        }
        db.exec(`PRAGMA user_version = ${migrations.length}`);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
