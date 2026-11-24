import type { DatabaseSync } from 'node:sqlite';
import { isSupportedCountry, type CountryCode } from 'libphonenumber-js';
import { DEFAULT_SETTINGS, type AppSettings, type BaseEnvironment, type Environment } from '../config/env.js';
import { decryptSecret, encryptSecret, isEncrypted, loadSecretKey, SecretError } from './secret.service.js';

export type EditableSettings = AppSettings;
export type SettingKey = keyof AppSettings;

interface SettingDefinition<K extends SettingKey> {
    secret?: boolean;
    parse(value: string): AppSettings[K] | undefined;
}

const definitions: { [K in SettingKey]: SettingDefinition<K> } = {
    GMAIL_USER: { parse: value => value.trim() },
    GMAIL_APP_PASSWORD: { secret: true, parse: value => value.replaceAll(/\s/gu, '') },
    DEFAULT_COUNTRY: {
        parse: value => {
            const code = value.trim().toUpperCase();
            return isSupportedCountry(code) ? code as CountryCode : undefined;
        },
    },
    MESSAGE_DELAY_MS: {
        parse: value => {
            const delay = Number(value);
            return /^\d+$/u.test(value) && delay <= 3_600_000 ? delay : undefined;
        },
    },
};
const keys = Object.keys(definitions) as SettingKey[];

export interface LoadedSettings {
    settings: AppSettings;
    unreadable: SettingKey[];
}

function storedValues(db: DatabaseSync): Map<SettingKey, string> {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return new Map(rows
        .filter(row => keys.includes(String(row.key) as SettingKey))
        .map(row => [String(row.key) as SettingKey, String(row.value)]));
}

export function loadSettings(env: BaseEnvironment, db: DatabaseSync): LoadedSettings {
    const settings: AppSettings = { ...DEFAULT_SETTINGS };
    const unreadable: SettingKey[] = [];
    for (const [key, stored] of storedValues(db)) {
        let raw = stored;
        if (definitions[key].secret) {
            try {
                raw = isEncrypted(stored) ? decryptSecret(stored, loadSecretKey(env.SECRET_KEY_FILE), key) : stored;
            } catch (error) {
                if (!(error instanceof SecretError)) throw error;
                unreadable.push(key);
                continue;
            }
        }
        const value = definitions[key].parse(raw);
        if (value === undefined) unreadable.push(key);
        else Object.assign(settings, { [key]: value });
    }
    return { settings, unreadable };
}

export function withSavedSettings(env: BaseEnvironment, db: DatabaseSync): Environment {
    return { ...env, ...loadSettings(env, db).settings };
}

function write(db: DatabaseSync, env: BaseEnvironment, values: Partial<Record<SettingKey, string>>): void {
    const upsert = db.prepare(`
        INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const timestamp = new Date().toISOString();
    const encode = (key: SettingKey, value: string) => (definitions[key].secret
        ? encryptSecret(value, loadSecretKey(env.SECRET_KEY_FILE), key)
        : value);
    const entries = keys.flatMap(key => (values[key] === undefined ? [] : [[key, encode(key, values[key])] as const]));
    if (!entries.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const [key, value] of entries) upsert.run(key, value, timestamp);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

export function saveSettings(db: DatabaseSync, env: BaseEnvironment, values: Partial<AppSettings>): void {
    write(db, env, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])));
}

export function migrateSettings(db: DatabaseSync, env: BaseEnvironment, legacy: NodeJS.ProcessEnv = process.env): SettingKey[] {
    const stored = storedValues(db);
    const pending: Partial<Record<SettingKey, string>> = {};
    for (const key of keys) {
        const saved = stored.get(key);
        const fromEnv = legacy[key]?.trim();
        if (saved === undefined && fromEnv && definitions[key].parse(fromEnv) !== undefined) pending[key] = fromEnv;
        if (saved !== undefined && definitions[key].secret && !isEncrypted(saved)) pending[key] = saved;
    }
    write(db, env, pending);
    return Object.keys(pending) as SettingKey[];
}
