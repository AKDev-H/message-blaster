import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { link, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { migrate } from './schema.js';

export function openDatabase(path: string): DatabaseSync {
    const filename = path === ':memory:' ? path : resolve(path);
    if (filename !== ':memory:') {
        mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
        try {
            closeSync(openSync(filename, 'wx', 0o600));
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
            if (!lstatSync(filename).isFile()) throw new Error('Database path must be a regular file', { cause: error });
            chmodSync(filename, 0o600);
        }
    }

    const db = new DatabaseSync(filename);
    try {
        db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `);
        migrate(db);
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = operation();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

export async function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(dirname(target), '.backup-'));
    const temporary = join(directory, 'backup.sqlite');
    try {
        const file = await open(temporary, 'wx', 0o600);
        await file.close();
        await backup(db, temporary);
        await link(temporary, target);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
