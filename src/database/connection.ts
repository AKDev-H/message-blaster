import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { link, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { hasErrorCode } from '../utils/fs.util.js';
import { migrate } from './schema.js';

export { transaction } from './transaction.js';

const IN_MEMORY = ':memory:';
const PRAGMAS = `
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
`;

export function openDatabase(path: string): DatabaseSync {
    const filename = path === IN_MEMORY ? path : resolve(path);
    if (filename !== IN_MEMORY) ensurePrivateFile(filename);
    return prepareDatabase(new DatabaseSync(filename));
}

export async function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(dirname(target), '.backup-'));
    try {
        await writeBackup(db, join(directory, 'backup.sqlite'), target);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function ensurePrivateFile(filename: string): void {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    try {
        closeSync(openSync(filename, 'wx', 0o600));
    } catch (error) {
        useExistingFile(filename, error);
    }
}

function useExistingFile(filename: string, error: unknown): void {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (!lstatSync(filename).isFile()) throw new Error('Database path must be a regular file', { cause: error });
    chmodSync(filename, 0o600);
}

function prepareDatabase(db: DatabaseSync): DatabaseSync {
    try {
        db.exec(PRAGMAS);
        migrate(db);
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

async function writeBackup(db: DatabaseSync, temporary: string, target: string): Promise<void> {
    const file = await open(temporary, 'wx', 0o600);
    await file.close();
    await backup(db, temporary);
    await link(temporary, target);
}
