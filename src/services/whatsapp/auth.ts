import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
    BufferJSON, initAuthCreds, proto,
    type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { privateDatabase } from './private-files.js';

export { acquireWhatsAppLease, privateDirectory } from './private-files.js';

export type WhatsAppAuth = ReturnType<typeof openWhatsAppAuth>;

export const LOGGED_OUT_ERROR = 'WhatsApp logged out this session. Archive the auth directory and run whatsapp:connect to pair again.';

const AUTH_SCHEMA = `
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS auth_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS signal_keys (
        category TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (category, id)
    ) STRICT;
`;
const GET_META = 'SELECT value FROM auth_meta WHERE name = ?';
const SET_META = 'INSERT INTO auth_meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value';
const GET_KEY = 'SELECT value FROM signal_keys WHERE category = ? AND id = ?';
const SET_KEY = `
    INSERT INTO signal_keys (category, id, value) VALUES (?, ?, ?) ON CONFLICT (category, id) DO UPDATE SET value = excluded.value
`;
const DELETE_KEY = 'DELETE FROM signal_keys WHERE category = ? AND id = ?';

export function openWhatsAppAuth(directory: string) {
    const db = privateDatabase(join(directory, 'auth-state.sqlite'));
    try {
        db.exec(AUTH_SCHEMA);
        return sessionFromDatabase(db);
    } catch (error) {
        db.close();
        throw error;
    }
}

function sessionFromDatabase(db: DatabaseSync) {
    const setMeta = db.prepare(SET_META);
    const creds = readCredentials(db);
    const state: AuthenticationState = { creds, keys: signalKeyStore(db) };
    return {
        state,
        saveCreds: () => setMeta.run('credentials', JSON.stringify(creds, BufferJSON.replacer)),
        markLoggedOut: () => setMeta.run('logged-out', '1'),
        close: () => db.close(),
    };
}

function readCredentials(db: DatabaseSync): AuthenticationCreds {
    const getMeta = db.prepare(GET_META);
    if (getMeta.get('logged-out')) throw new Error(LOGGED_OUT_ERROR);
    const stored = getMeta.get('credentials');
    return stored ? JSON.parse(String(stored.value), BufferJSON.reviver) as AuthenticationCreds : initAuthCreds();
}

function signalKeyStore(db: DatabaseSync): AuthenticationState['keys'] {
    const getKey = db.prepare(GET_KEY);
    return {
        get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
            const found = Object.create(null) as Record<string, SignalDataTypeMap[T]>;
            for (const id of ids) {
                const row = getKey.get(type, id);
                if (row) found[id] = parseKey(type, String(row.value));
            }
            return found;
        },
        set: data => saveKeys(db, data),
    };
}

function parseKey<T extends keyof SignalDataTypeMap>(type: T, stored: string): SignalDataTypeMap[T] {
    const value = JSON.parse(stored, BufferJSON.reviver);
    return (type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value) as SignalDataTypeMap[T];
}

function saveKeys(db: DatabaseSync, data: SignalDataSet): void {
    db.exec('BEGIN IMMEDIATE');
    try {
        writeKeys(db, data);
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw new Error('Could not persist WhatsApp session keys.', { cause: error });
    }
}

function writeKeys(db: DatabaseSync, data: SignalDataSet): void {
    const setKey = db.prepare(SET_KEY);
    const deleteKey = db.prepare(DELETE_KEY);
    for (const [category, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
            if (value == null) deleteKey.run(category, id);
            else setKey.run(category, id, JSON.stringify(value, BufferJSON.replacer));
        }
    }
}
