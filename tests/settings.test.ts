import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadEnv } from '../src/config/env.js';
import { openDatabase } from '../src/database/connection.js';
import { decryptSecret, encryptSecret, loadSecretKey, SecretError } from '../src/services/secret.service.js';
import { loadSettings, migrateSettings, saveSettings } from '../src/services/settings.service.js';

async function setup(t: TestContext) {
    const directory = await mkdtemp(join(tmpdir(), 'settings-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env = { ...loadEnv(), DATABASE_URL: join(directory, 'app.db'), SECRET_KEY_FILE: join(directory, 'keys', 'secret.key') };
    const db = openDatabase(env.DATABASE_URL);
    t.after(() => db.close());
    const stored = (key: string) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    return { directory, env, db, stored };
}

test('secrets round-trip, are bound to their setting and fail closed', async (t) => {
    const { env } = await setup(t);
    const key = loadSecretKey(env.SECRET_KEY_FILE);
    assert.equal((await stat(env.SECRET_KEY_FILE)).mode & 0o777, 0o600);
    assert.equal(loadSecretKey(env.SECRET_KEY_FILE), key, 'the key is created once and cached');
    const sealed = encryptSecret('abcdefghijklmnop', key, 'GMAIL_APP_PASSWORD');
    assert.notEqual(sealed, encryptSecret('abcdefghijklmnop', key, 'GMAIL_APP_PASSWORD'), 'each value gets a fresh IV');
    assert.equal(decryptSecret(sealed, key, 'GMAIL_APP_PASSWORD'), 'abcdefghijklmnop');
    assert.throws(() => decryptSecret(sealed, key, 'GMAIL_USER'), SecretError);
    assert.throws(() => decryptSecret(sealed, Buffer.alloc(32), 'GMAIL_APP_PASSWORD'), SecretError);
    assert.throws(() => decryptSecret(`${sealed.slice(0, -2)}AA`, key, 'GMAIL_APP_PASSWORD'), SecretError);
});

test('saved settings encrypt the App Password and ignore invalid values', async (t) => {
    const { env, db, stored } = await setup(t);
    saveSettings(db, env, { GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop', DEFAULT_COUNTRY: 'SG', MESSAGE_DELAY_MS: 2_500 });
    assert.match(String(stored('GMAIL_APP_PASSWORD')), /^enc:v1:/u);
    assert.deepEqual(loadSettings(env, db), {
        settings: { GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop', DEFAULT_COUNTRY: 'SG', MESSAGE_DELAY_MS: 2_500 },
        unreadable: [],
    });

    db.prepare("UPDATE settings SET value = 'XX' WHERE key = 'DEFAULT_COUNTRY'").run();
    db.prepare("UPDATE settings SET value = 'enc:v1:broken' WHERE key = 'GMAIL_APP_PASSWORD'").run();
    const { settings, unreadable } = loadSettings(env, db);
    assert.equal(settings.DEFAULT_COUNTRY, 'MY');
    assert.equal(settings.GMAIL_APP_PASSWORD, '');
    assert.deepEqual(unreadable.sort(), ['DEFAULT_COUNTRY', 'GMAIL_APP_PASSWORD']);
});

test('migration imports values left in .env once and encrypts plain-text secrets', async (t) => {
    const { env, db, stored } = await setup(t);
    db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('GMAIL_APP_PASSWORD', 'plaintextsecret1', 'now')").run();
    const legacy = { GMAIL_USER: 'old@gmail.com', GMAIL_APP_PASSWORD: 'ignored-env-pass', DEFAULT_COUNTRY: 'nope', MESSAGE_DELAY_MS: '3000' };
    assert.deepEqual(migrateSettings(db, env, legacy).sort(), ['GMAIL_APP_PASSWORD', 'GMAIL_USER', 'MESSAGE_DELAY_MS']);
    assert.match(String(stored('GMAIL_APP_PASSWORD')), /^enc:v1:/u);
    assert.equal(stored('DEFAULT_COUNTRY'), undefined, 'invalid legacy values are skipped');
    const { settings } = loadSettings(env, db);
    assert.equal(settings.GMAIL_APP_PASSWORD, 'plaintextsecret1', 'the saved value wins over .env');
    assert.equal(settings.GMAIL_USER, 'old@gmail.com');
    assert.equal(settings.MESSAGE_DELAY_MS, 3_000);
    assert.deepEqual(migrateSettings(db, env, legacy), [], 'running again changes nothing');
});

test('a corrupt key file is reported instead of being replaced', async (t) => {
    const { env } = await setup(t);
    const path = join(env.SECRET_KEY_FILE, '..', 'corrupt.key');
    loadSecretKey(env.SECRET_KEY_FILE);
    await writeFile(path, 'not-a-key');
    assert.throws(() => loadSecretKey(path), /not a valid key/);
});
