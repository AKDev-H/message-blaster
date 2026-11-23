import {
    chmodSync, constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    BufferJSON, initAuthCreds, proto,
    type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap
} from '@whiskeysockets/baileys';

export function privateDirectory(path: string): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) {
        throw new Error('The WhatsApp storage path must be a directory and cannot be a symbolic link.');
    }

    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = fstatSync(fd);
        if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
            throw new Error('The WhatsApp storage directory must belong to the current user.');
        }
        fchmodSync(fd, 0o700);
        return realpathSync(path);
    } finally {
        closeSync(fd);
    }
}

function privateDatabase(path: string): DatabaseSync {
    try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        closeSync(fd);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
        throw new Error('WhatsApp storage must use a regular local file owned by the current user.');
    }
    chmodSync(path, 0o600);
    return new DatabaseSync(path);
}

/** The operating system releases the SQLite write lock if this process exits. */
export function acquireWhatsAppLease(path: string, busyMessage: string): DatabaseSync {
    const db = privateDatabase(join(privateDirectory(dirname(path)), basename(path)));
    try {
        db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
        return db;
    } catch (error) {
        db.close();
        const code = (error as { errcode?: number }).errcode;
        if (code === 5 || code === 6) {
            throw new Error(busyMessage, { cause: error });
        }
        throw error;
    }
}

export function openWhatsAppAuth(directory: string) {
    const db = privateDatabase(join(directory, 'auth-state.sqlite'));
    try {
        db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS auth_meta (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS signal_keys (
        category TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (category, id)
      ) STRICT;
    `);

        const getMeta = db.prepare('SELECT value FROM auth_meta WHERE name = ?');
        const setMeta = db.prepare(`
      INSERT INTO auth_meta (name, value) VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value
    `);
        if (getMeta.get('logged-out')) {
            throw new Error('WhatsApp logged out this session. Archive the auth directory and run whatsapp:connect to pair again.');
        }

        const stored = getMeta.get('credentials');
        const creds: AuthenticationCreds = stored
            ? JSON.parse(String(stored.value), BufferJSON.reviver) as AuthenticationCreds
            : initAuthCreds();

        const selectKey = db.prepare('SELECT value FROM signal_keys WHERE category = ? AND id = ?');
        const setKey = db.prepare(`
      INSERT INTO signal_keys (category, id, value) VALUES (?, ?, ?)
      ON CONFLICT (category, id) DO UPDATE SET value = excluded.value
    `);
        const deleteKey = db.prepare('DELETE FROM signal_keys WHERE category = ? AND id = ?');

        const state: AuthenticationState = {
            creds,
            keys: {
                get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
                    const result = Object.create(null) as Record<string, SignalDataTypeMap[T]>;
                    for (const id of ids) {
                        const row = selectKey.get(type, id);
                        if (row) {
                            const value = JSON.parse(String(row.value), BufferJSON.reviver);
                            result[id] = (type === 'app-state-sync-key'
                                ? proto.Message.AppStateSyncKeyData.fromObject(value)
                                : value) as SignalDataTypeMap[T];
                        }
                    }
                    return result;
                },
                set(data) {
                    db.exec('BEGIN IMMEDIATE');
                    try {
                        for (const [category, entries] of Object.entries(data)) {
                            for (const [id, value] of Object.entries(entries)) {
                                if (value == null) {
                                    deleteKey.run(category, id);
                                } else {
                                    setKey.run(category, id, JSON.stringify(value, BufferJSON.replacer));
                                }
                            }
                        }
                        db.exec('COMMIT');
                    } catch (error) {
                        if (db.isTransaction) {
                            db.exec('ROLLBACK');
                        }
                        throw new Error('Could not persist WhatsApp session keys.', { cause: error });
                    }
                }
            }
        };

        return {
            state,
            saveCreds: () => setMeta.run('credentials', JSON.stringify(creds, BufferJSON.replacer)),
            markLoggedOut: () => setMeta.run('logged-out', '1'),
            close: () => db.close()
        };
    } catch (error) {
        db.close();
        throw error;
    }
}
