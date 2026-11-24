import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuthStore, type AuditEvent } from '../src/auth/store.js';
import { loadEnv } from '../src/config/env.js';
import { openDatabase } from '../src/database/connection.js';
import { startWebServer } from '../src/web/server.js';
import { approveTestUser, authenticatedFetch, mockGoogle, TEST_EMAIL, testLogin } from './support/web-auth.js';

test('dashboard protects private routes, revokes live streams, and persists administrator-only audit history', { timeout: 8_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-web-auth-'));
    const env = {
        ...loadEnv(),
        DATABASE_URL: join(directory, 'app.db'),
        ATTACHMENTS_DIR: join(directory, 'files'),
        LOG_DIR: join(directory, 'logs'),
        SECRET_KEY_FILE: join(directory, 'secret.key'),
        DRY_RUN: true,
        MAINTENANCE_MODE: false,
    };
    approveTestUser(env.DATABASE_URL);
    const dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    const { url } = dashboard;
    context.after(async () => {
        await dashboard.close();
        await rm(directory, { recursive: true, force: true });
    });

    for (const path of ['/api/campaigns', '/api/events', '/api/campaigns/example/export', '/api/attachments/example.pdf', '/api/audit']) {
        assert.equal((await fetch(url + path)).status, 401, path);
    }
    for (const path of ['/', '/audit', '/app.mjs']) {
        const result = await fetch(url + path, { redirect: 'manual' });
        assert.equal(result.headers.get('location'), '/login', path);
    }
    assert.equal((await fetch(url + '/auth/google', { method: 'POST' })).status, 403);
    assert.equal((await fetch(url + '/auth/google', { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);

    const cookie = await testLogin(url);
    const request = authenticatedFetch(url, cookie);
    assert.equal((await fetch(url + '/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request('/api/session')).status, 200);
    const settings = await request('/api/settings/sending', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country: 'MY', delaySeconds: 4 }),
    });
    assert.equal(settings.status, 200);
    const { events } = await (await request('/api/audit')).json() as { events: AuditEvent[] };
    assert.ok(events.some(event => event.actorId === 1 && event.action === 'sender.delivery.settings' && event.outcome === 'success'));

    const stream = await request('/api/events', { signal: AbortSignal.timeout(5_000) });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.equal((await reader.read()).done, false);
    {
        using db = openDatabase(env.DATABASE_URL);
        const users = new AuthStore(db);
        users.allowUser('backup@gmail.com', 'admin');
        users.setUserEnabled(users.userByEmail(TEST_EMAIL)!.id, false);
    }
    assert.equal((await reader.read()).done, true);
    assert.equal((await request('/api/campaigns')).status, 401);
    const disabledLogin = await fetch(url + '/auth/google', { method: 'POST', headers: { Origin: url } });
    const { url: callback } = await disabledLogin.json() as { url: string };
    const denied = await fetch(new URL(callback, url), {
        headers: { Cookie: disabledLogin.headers.getSetCookie()[0]!.split(';')[0]! }, redirect: 'manual',
    });
    assert.equal(denied.headers.get('location'), '/login?denied=1');
    assert.equal(denied.headers.getSetCookie().length, 0);
});

test('operators can read campaigns and sign out but cannot read the audit log', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-web-operator-'));
    const env = { ...loadEnv(), DATABASE_URL: join(directory, 'app.db'), DRY_RUN: true, MAINTENANCE_MODE: false };
    approveTestUser(env.DATABASE_URL, 'operator');
    const dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    context.after(async () => {
        await dashboard.close();
        await rm(directory, { recursive: true, force: true });
    });
    const request = authenticatedFetch(dashboard.url, await testLogin(dashboard.url));
    assert.equal((await request('/api/campaigns')).status, 200);
    assert.equal((await request('/api/audit')).status, 403);
    assert.equal((await request('/audit')).status, 403);
    assert.equal((await request('/auth/logout', { method: 'POST' })).status, 204);
    assert.equal((await request('/api/campaigns')).status, 401);
});
