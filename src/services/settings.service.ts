import type { DatabaseSync } from 'node:sqlite';
import type { CountryCode } from 'libphonenumber-js';
import type { Environment } from '../config/env.js';

export interface EditableSettings {
    GMAIL_USER: string;
    GMAIL_APP_PASSWORD: string;
    DEFAULT_COUNTRY: CountryCode;
    MESSAGE_DELAY_MS: number;
}

export type SettingKey = keyof EditableSettings;
const keys: readonly SettingKey[] = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'DEFAULT_COUNTRY', 'MESSAGE_DELAY_MS'];

function readSaved(db: DatabaseSync): Partial<Record<SettingKey, string>> {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const saved: Partial<Record<SettingKey, string>> = {};
    for (const row of rows) {
        const key = String(row.key) as SettingKey;
        if (keys.includes(key)) saved[key] = String(row.value);
    }
    return saved;
}

export function withSavedSettings<T extends Environment>(env: T, db: DatabaseSync): T {
    const saved = readSaved(db);
    return {
        ...env,
        ...(saved.GMAIL_USER !== undefined ? { GMAIL_USER: saved.GMAIL_USER } : {}),
        ...(saved.GMAIL_APP_PASSWORD !== undefined ? { GMAIL_APP_PASSWORD: saved.GMAIL_APP_PASSWORD } : {}),
        ...(saved.DEFAULT_COUNTRY !== undefined ? { DEFAULT_COUNTRY: saved.DEFAULT_COUNTRY as CountryCode } : {}),
        ...(saved.MESSAGE_DELAY_MS !== undefined ? { MESSAGE_DELAY_MS: Number(saved.MESSAGE_DELAY_MS) } : {}),
    };
}

export function saveSettings(db: DatabaseSync, values: Partial<EditableSettings>): void {
    const upsert = db.prepare(`
        INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const timestamp = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const key of keys) {
            const value = values[key];
            if (value !== undefined) upsert.run(key, String(value), timestamp);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
