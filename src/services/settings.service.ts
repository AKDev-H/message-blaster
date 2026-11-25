import type { DatabaseSync } from 'node:sqlite';
import { isSupportedCountry, type CountryCode } from 'libphonenumber-js';
import { DEFAULT_SETTINGS, EMAIL_PROVIDERS, SMTP_SECURITY_MODES, type AppSettings, type BaseEnvironment, type Environment } from '../config/env.js';
import { transaction } from '../database/transaction.js';
import { decryptSecret, encryptSecret, isEncrypted, loadSecretKey, SecretError } from './secret.service.js';

export type EditableSettings = AppSettings;
export type SettingKey = keyof AppSettings;
type RawValues = Partial<Record<SettingKey, string>>;

interface SettingDefinition<K extends SettingKey> {
    secret?: boolean;
    parse(value: string): AppSettings[K] | undefined;
}

const DEFINITIONS: { [K in SettingKey]: SettingDefinition<K> } = {
    EMAIL_PROVIDER: { parse: value => oneOf(EMAIL_PROVIDERS, value) },
    GMAIL_USER: { parse: value => value.trim() },
    GMAIL_APP_PASSWORD: { secret: true, parse: value => value.replaceAll(/\s/gu, '') },
    SMTP_HOST: { parse: value => value.trim() },
    SMTP_PORT: { parse: parsePort },
    SMTP_SECURITY: { parse: value => oneOf(SMTP_SECURITY_MODES, value) },
    SMTP_USER: { parse: value => value.trim() },
    SMTP_PASSWORD: { secret: true, parse: value => value },
    SMTP_FROM: { parse: value => value.trim() },
    SMTP_FROM_NAME: { parse: value => value.trim() },
    DEFAULT_COUNTRY: { parse: parseCountry },
    MESSAGE_DELAY_MS: { parse: parseDelay },
};
const KEYS = Object.keys(DEFINITIONS) as SettingKey[];

const UPSERT = `
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`;

export interface LoadedSettings {
    settings: AppSettings;
    unreadable: SettingKey[];
}

export function loadSettings(env: BaseEnvironment, db: DatabaseSync): LoadedSettings {
    const settings: AppSettings = { ...DEFAULT_SETTINGS };
    const unreadable: SettingKey[] = [];
    for (const [key, stored] of storedValues(db)) {
        const value = readSetting(env, key, stored);
        if (value === undefined) unreadable.push(key);
        else Object.assign(settings, { [key]: value });
    }
    return { settings, unreadable };
}

export function withSavedSettings(env: BaseEnvironment, db: DatabaseSync): Environment {
    return { ...env, ...loadSettings(env, db).settings };
}

export function saveSettings(db: DatabaseSync, env: BaseEnvironment, values: Partial<AppSettings>): void {
    writeSettings(db, env, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])));
}

export function migrateSettings(db: DatabaseSync, env: BaseEnvironment, legacy: NodeJS.ProcessEnv = process.env): SettingKey[] {
    const stored = storedValues(db);
    const pending: RawValues = {};
    for (const key of KEYS) {
        const value = valueToMigrate(key, stored.get(key), legacy[key]?.trim());
        if (value !== undefined) pending[key] = value;
    }
    writeSettings(db, env, pending);
    return Object.keys(pending) as SettingKey[];
}

function parseCountry(value: string): CountryCode | undefined {
    const code = value.trim().toUpperCase();
    return isSupportedCountry(code) ? code as CountryCode : undefined;
}

function oneOf<T extends string>(options: readonly T[], value: string): T | undefined {
    const trimmed = value.trim();
    return options.find(option => option === trimmed);
}

function parsePort(value: string): number | undefined {
    const port = Number(value);
    return /^\d+$/u.test(value) && port >= 1 && port <= 65_535 ? port : undefined;
}

function parseDelay(value: string): number | undefined {
    const delay = Number(value);
    return /^\d+$/u.test(value) && delay <= 3_600_000 ? delay : undefined;
}

function storedValues(db: DatabaseSync): Map<SettingKey, string> {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const known = rows.filter(row => KEYS.includes(String(row.key) as SettingKey));
    return new Map(known.map(row => [String(row.key) as SettingKey, String(row.value)]));
}

function readSetting(env: BaseEnvironment, key: SettingKey, stored: string) {
    const raw = DEFINITIONS[key].secret ? revealSecret(env, key, stored) : stored;
    return raw === undefined ? undefined : DEFINITIONS[key].parse(raw);
}

function revealSecret(env: BaseEnvironment, key: SettingKey, stored: string): string | undefined {
    if (!isEncrypted(stored)) return stored;
    try {
        return decryptSecret(stored, loadSecretKey(env.SECRET_KEY_FILE), key);
    } catch (error) {
        if (error instanceof SecretError) return undefined;
        throw error;
    }
}

function valueToMigrate(key: SettingKey, saved: string | undefined, fromEnv: string | undefined): string | undefined {
    const plainSecret = saved !== undefined && DEFINITIONS[key].secret && !isEncrypted(saved);
    const unsavedEnvValue = saved === undefined && fromEnv && DEFINITIONS[key].parse(fromEnv) !== undefined;
    if (plainSecret) return saved;
    return unsavedEnvValue ? fromEnv : undefined;
}

function writeSettings(db: DatabaseSync, env: BaseEnvironment, values: RawValues): void {
    const entries = KEYS.flatMap(key => (values[key] === undefined ? [] : [[key, encode(env, key, values[key])] as const]));
    if (!entries.length) return;
    const upsert = db.prepare(UPSERT);
    const timestamp = new Date().toISOString();
    transaction(db, () => entries.forEach(([key, value]) => upsert.run(key, value, timestamp)));
}

function encode(env: BaseEnvironment, key: SettingKey, value: string): string {
    return DEFINITIONS[key].secret ? encryptSecret(value, loadSecretKey(env.SECRET_KEY_FILE), key) : value;
}
