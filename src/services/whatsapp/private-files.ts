import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hasErrorCode } from '../../utils/fs.util.js';

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function privateDirectory(path: string): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new Error('The WhatsApp storage path must be a directory and cannot be a symbolic link.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        restrictOwnedDirectory(fd);
        return realpathSync(path);
    } finally {
        closeSync(fd);
    }
}

export function privateDatabase(path: string): DatabaseSync {
    createIfMissing(path);
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || !isOwnedByMe(info)) {
        throw new Error('WhatsApp storage must use a regular local file owned by the current user.');
    }
    chmodSync(path, 0o600);
    return new DatabaseSync(path);
}

export function acquireWhatsAppLease(path: string, busyMessage: string): DatabaseSync {
    const db = privateDatabase(join(privateDirectory(dirname(path)), basename(path)));
    try {
        db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
        return db;
    } catch (error) {
        db.close();
        if (isLockedError(error)) throw new Error(busyMessage, { cause: error });
        throw error;
    }
}

function restrictOwnedDirectory(fd: number): void {
    const info = fstatSync(fd);
    if (!info.isDirectory() || !isOwnedByMe(info)) throw new Error('The WhatsApp storage directory must belong to the current user.');
    fchmodSync(fd, 0o700);
}

function createIfMissing(path: string): void {
    try {
        closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
}

function isOwnedByMe(info: Stats): boolean {
    return !process.getuid || info.uid === process.getuid();
}

function isLockedError(error: unknown): boolean {
    const code = (error as { errcode?: number }).errcode;
    return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}
