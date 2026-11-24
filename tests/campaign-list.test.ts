import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_SETTINGS, loadEnv } from '../src/config/env.js';
import { openDatabase } from '../src/database/connection.js';
import { Store, type PreparedRow } from '../src/store/index.js';
import type { CampaignChannel, MessageStatus } from '../src/types/index.js';
import { startWebServer } from '../src/web/server.js';
import { approveTestUser, authenticatedFetch, mockGoogle, testLogin } from './support/web-auth.js';

function row(rowNumber: number): PreparedRow {
    return {
        rowNumber, clientName: 'Example', phone: `+6012300${String(rowNumber).padStart(4, '0')}`, email: `c${rowNumber}@example.com`,
        subject: 'Hi', message: 'Hello', pdfFilename: '', consentStatus: 'Opted In',
    };
}

function seed(store: Store, db: ReturnType<typeof openDatabase>, id: string, channel: CampaignChannel, statuses: MessageStatus[] = []) {
    store.importCampaign(id, [1, 2, 3].map(row), false, channel);
    const move = db.prepare(`UPDATE messages SET status = ? WHERE id = (
        SELECT id FROM messages WHERE campaign_id = ? AND status IN ('PENDING', 'QUEUED') ORDER BY row_number LIMIT 1)`);
    for (const status of statuses) move.run(status, id);
}

function memory(context: TestContext) {
    const db = openDatabase(':memory:');
    context.after(() => db.close());
    return { db, store: new Store(db) };
}

const ids = (page: ReturnType<Store['listCampaignPage']>) => page.campaigns.map(campaign => campaign.id).sort();

test('campaign list filters by status and channel in SQL and pages ten at a time', context => {
    const { db, store } = memory(context);
    seed(store, db, 'mail-sent', 'gmail', ['DELIVERED', 'DELIVERED', 'READ']);
    seed(store, db, 'mail-failed', 'gmail', ['DELIVERED', 'FAILED']);
    seed(store, db, 'chat-review', 'whatsapp', ['UNKNOWN']);
    seed(store, db, 'chat-sending', 'whatsapp', ['SENDING']);
    store.importCampaign('hidden-test', [row(1)], true, 'gmail');

    const all = store.listCampaignPage({ page: 1, pageSize: 10 });
    assert.deepEqual(ids(all), ['chat-review', 'chat-sending', 'mail-failed', 'mail-sent'], 'test sends never appear in the list');
    assert.equal(all.allCampaigns, 4);
    assert.deepEqual(all.totals, { queued: 5, processing: 1, completed: 4, failed: 1, unknown: 1 });

    assert.deepEqual(ids(store.listCampaignPage({ status: 'queued', page: 1, pageSize: 10 })), ['chat-review', 'chat-sending', 'mail-failed']);
    assert.deepEqual(ids(store.listCampaignPage({ status: 'processing', page: 1, pageSize: 10 })), ['chat-sending']);
    assert.deepEqual(ids(store.listCampaignPage({ status: 'completed', page: 1, pageSize: 10 })), ['mail-failed', 'mail-sent']);
    assert.deepEqual(ids(store.listCampaignPage({ status: 'failed', page: 1, pageSize: 10 })), ['chat-review', 'mail-failed'], 'needs-review counts as failed');

    const whatsapp = store.listCampaignPage({ channel: 'whatsapp', page: 1, pageSize: 10 });
    assert.deepEqual(ids(whatsapp), ['chat-review', 'chat-sending']);
    assert.deepEqual(whatsapp.totals, { queued: 4, processing: 1, completed: 0, failed: 0, unknown: 1 }, 'status counts follow the channel filter');
    assert.equal(whatsapp.allCampaigns, 4, 'the overall total ignores filters');
    assert.deepEqual(ids(store.listCampaignPage({ channel: 'gmail', status: 'failed', page: 1, pageSize: 10 })), ['mail-failed']);

    for (let index = 0; index < 19; index += 1) store.importCampaign(`bulk-${String(index).padStart(2, '0')}`, [row(1)], false, 'gmail');
    const first = store.listCampaignPage({ page: 1, pageSize: 10 });
    const third = store.listCampaignPage({ page: 3, pageSize: 10 });
    assert.equal(first.campaigns.length, 10);
    assert.equal(first.totalPages, 3);
    assert.equal(first.matching, 23);
    assert.equal(third.campaigns.length, 3);
    assert.equal(new Set([...ids(first), ...ids(store.listCampaignPage({ page: 2, pageSize: 10 })), ...ids(third)]).size, 23, 'pages never overlap');
    assert.equal(store.listCampaignPage({ page: 99, pageSize: 10 }).page, 3, 'a page past the end shows the last page');
});

test('the dashboard API validates filters, and unknown pages, errors and maintenance get their own screens', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-list-'));
    const env = { ...loadEnv(), ...DEFAULT_SETTINGS, DATABASE_URL: join(directory, 'app.db'), LOG_DIR: join(directory, 'logs'), MAINTENANCE_MODE: false };
    approveTestUser(env.DATABASE_URL);
    const dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    context.after(async () => {
        await dashboard.close();
        await rm(directory, { recursive: true, force: true });
    });
    const request = authenticatedFetch(dashboard.url, await testLogin(dashboard.url));
    const get = (path: string, html = false) => request(path, html ? { headers: { Accept: 'text/html' } } : undefined);

    const list = await (await get('/api/campaigns?status=failed&channel=whatsapp&page=1')).json() as Record<string, unknown>;
    assert.deepEqual([list.page, list.pageSize, list.matching, list.campaigns], [1, 10, 0, []]);
    assert.ok(Array.isArray(list.active));
    assert.equal((await get('/api/campaigns?status=everything')).status, 400);
    assert.equal((await get('/api/campaigns?channel=sms')).status, 400);
    assert.equal((await get('/api/campaigns?page=0')).status, 400);

    const missing = await get('/no/such/page', true);
    assert.equal(missing.status, 404);
    const missingPage = await missing.text();
    assert.match(missingPage, /This page isn’t on the route/u);
    assert.match(missingPage, /<a class="status-button primary" href="\/" data-action="home">.*Way Back Home/u);
    const failure = await get('/errors/500', true);
    assert.match(await failure.text(), /data-action="retry">.*<span>Retry<\/span>/u);
    assert.equal((await get('/api/nothing-here')).headers.get('content-type'), 'application/json; charset=utf-8', 'API callers still get JSON');
    assert.equal((await get('/errors/500', true)).status, 500);
    assert.equal((await get('/errors/maintenance', true)).status, 503);
    assert.equal((await get('/animations/lost-message.json')).status, 200);
    assert.equal((await get('/vendor/lottie.js')).status, 200);
});

test('maintenance mode shows the maintenance page and pauses the API while assets still load', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-maintenance-'));
    const env = { ...loadEnv(), ...DEFAULT_SETTINGS, DATABASE_URL: join(directory, 'app.db'), LOG_DIR: join(directory, 'logs'), MAINTENANCE_MODE: true };
    approveTestUser(env.DATABASE_URL);
    const dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    context.after(async () => {
        await dashboard.close();
        await rm(directory, { recursive: true, force: true });
    });

    const request = authenticatedFetch(dashboard.url, await testLogin(dashboard.url));
    const home = await request('/', { headers: { Accept: 'text/html' } });
    assert.equal(home.status, 503);
    assert.equal(home.headers.get('retry-after'), '120');
    assert.match(await home.text(), /Message Blaster is being updated/u);
    const api = await request('/api/campaigns');
    assert.equal(api.status, 503);
    assert.match((await api.json() as { error: string }).error, /maintenance/u);
    assert.equal((await request('/pages.css')).status, 200);
});
