import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import pino from 'pino';
import { backupDatabase, openDatabase } from '../src/database/connection.js';
import { prepareRows } from '../src/services/campaign/prepare-rows.js';
import type { ImportRow } from '../src/services/excel/columns.js';
import { Store, type PreparedRow } from '../src/store/index.js';
import type { MessageTransport } from '../src/types/index.js';
import { runCampaign } from '../src/workers/campaign.worker.js';

const logger = pino({ level: 'silent' });
const settings = {
    ATTACHMENTS_DIR: './tests/fixtures',
    MAX_MESSAGES_PER_RUN: 100,
    MESSAGE_DELAY_MS: 0,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 100,
    SENDER_CONCURRENCY: 1,
};

function row(rowNumber: number, data: Partial<PreparedRow> = {}): PreparedRow {
    return {
        rowNumber,
        clientName: 'Example',
        phone: `+6012345${String(rowNumber).padStart(4, '0')}`,
        message: 'Example message',
        pdfFilename: '',
        consentStatus: 'Opted In',
        ...data,
    };
}

function memoryStore(context: TestContext) {
    const db = openDatabase(':memory:');
    context.after(() => db.close());
    return new Store(db);
}

function processWith(store: Store, id: string, transport: MessageTransport, overrides = {}) {
    return runCampaign(store, id, { ...settings, ...overrides }, transport, logger, new AbortController().signal);
}

test('campaign preparation excludes duplicate normalized phones, missing consent and withdrawals', async context => {
    const store = memoryStore(context);
    store.withdraw('+60123456789');
    const toImport = (prepared: PreparedRow): ImportRow => ({ ...prepared, campaignId: 'checks' });
    const input = [
        row(2, { phone: '0122345678' }), row(3, { phone: '+60122345678', consentStatus: 'Not Opted In' }),
        row(4, { phone: '0123456789' }), row(5, { phone: '+12025550123', message: '', consentStatus: 'opted in' }),
    ].map(toImport);
    const prepared = await prepareRows(store, { ...settings, DEFAULT_COUNTRY: 'MY' }, 'checks', input, 'Hello {{client_name}} ({{campaign_id}})');
    store.importCampaign('checks', prepared);
    assert.deepEqual(store.listMessages('checks').map(item => item.status), ['SKIPPED', 'SKIPPED', 'SKIPPED', 'PENDING']);
    assert.equal(store.listMessages('checks')[3]?.message, 'Hello Example (checks)');
});

test('worker never retries a transport error and preserves early and late receipt evidence', async context => {
    const store = memoryStore(context);
    store.importCampaign('receipts', [row(1), row(2), row(3)]);
    store.start('receipts');
    const ids: string[] = [];
    const fake: MessageTransport = {
        isReady: true,
        async send(message) {
            ids.push(message.id);
            if (ids.length === 1) {
                store.receipt(message.id, 'READ');
                throw new Error('socket closed after read event');
            }
            if (ids.length === 2) throw new Error('response lost after submission');
        },
    };
    assert.equal(await processWith(store, 'receipts', fake), 3);
    assert.deepEqual(store.listMessages('receipts').map(item => item.status), ['READ', 'UNKNOWN', 'SENT']);
    assert.equal(store.listMessages('receipts')[2]?.deliveredAt, null);
    store.receipt(ids[0]!, 'ACKNOWLEDGED');
    store.receipt(ids[1]!, 'DELIVERED');
    assert.deepEqual(store.listMessages('receipts').map(item => item.status), ['READ', 'DELIVERED', 'SENT']);
    assert.deepEqual(store.listAttempts('receipts').map(item => item.state), ['SENT', 'UNKNOWN', 'SENT']);
});

test('changed PDF fails locally while the remaining batch proceeds and resumes', async context => {
    const dir = await mkdtemp(join(tmpdir(), 'bulk-worker-'));
    context.after(() => rm(dir, { recursive: true, force: true }));
    const store = memoryStore(context);
    await writeFile(join(dir, 'sample.pdf'), await readFile('tests/fixtures/sample-document.pdf'));
    const input: ImportRow[] = [
        { ...row(1, { pdfFilename: 'sample.pdf' }), campaignId: 'files' },
        { ...row(2), campaignId: 'files' },
        { ...row(3), campaignId: 'files' },
    ];
    const prepared = await prepareRows(store, { ATTACHMENTS_DIR: dir, DEFAULT_COUNTRY: 'MY' }, 'files', input, '');
    await writeFile(join(dir, 'sample.pdf'), await readFile('tests/fixtures/sample-invoice.pdf'));
    store.importCampaign('files', prepared);
    store.start('files');
    const phones: string[] = [];
    const fake: MessageTransport = { isReady: true, async send(message) { phones.push(message.phone); } };
    await processWith(store, 'files', fake, { ATTACHMENTS_DIR: dir, MAX_MESSAGES_PER_RUN: 2 });
    assert.equal(store.getCampaign('files').state, 'Paused');
    assert.deepEqual(store.listMessages('files').map(item => item.status), ['FAILED', 'SENT', 'QUEUED']);
    assert.match(store.listMessages('files')[0]?.errorMessage ?? '', /PDF changed/);
    store.resume('files');
    await processWith(store, 'files', fake, { ATTACHMENTS_DIR: dir });
    assert.equal(store.getCampaign('files').state, 'Completed');
    assert.deepEqual(phones, [input[1]?.phone, input[2]?.phone]);
});

test('crash recovery across connections marks in-flight rows unknown and never reclaims them', async context => {
    const dir = await mkdtemp(join(tmpdir(), 'bulk-recovery-'));
    context.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'app.db');
    const first = openDatabase(path);
    const beforeCrash = new Store(first);
    beforeCrash.importCampaign('recover', [row(1), row(2), row(3)]);
    beforeCrash.start('recover');
    const pending = beforeCrash.peek('recover')!;
    assert.ok(beforeCrash.claim('recover', pending.id, 'original-message-id'));
    first.close();

    using db = openDatabase(path);
    const store = new Store(db);
    assert.equal(store.recover(), 1);
    assert.equal(store.getCampaign('recover').state, 'Paused');
    assert.ok(store.getCampaign('recover').interruptedAt, 'a crash is flagged so the dashboard can explain the pause');
    assert.equal(store.withdraw(row(2).phone), 1);
    store.resume('recover');
    assert.equal(store.getCampaign('recover').interruptedAt, null, 'resuming clears the flag');
    const sent: string[] = [];
    await processWith(store, 'recover', { isReady: true, async send(message) { sent.push(message.phone); } });
    assert.deepEqual(sent, [row(3).phone]);
    assert.deepEqual(store.listMessages('recover').map(item => item.status), ['UNKNOWN', 'SKIPPED', 'SENT']);
    store.review(pending.id, 'FAILED', 'Confirmed absent from the recipient chat');
    assert.equal(store.listMessages('recover')[0]?.status, 'FAILED');
    await backupDatabase(db, join(dir, 'copy.db'));
    using copy = openDatabase(join(dir, 'copy.db'));
    assert.equal(new Store(copy).listAttempts('recover').length, 2);
});

test('test confirmation is scoped to a single registered recipient and the linked account', context => {
    const store = memoryStore(context);
    assert.throws(() => store.importCampaign('invalid-test', [row(1), row(2)], true), /one eligible/);
    store.importCampaign('test', [row(1)], true);
    store.bindAccount('test', 'account-a');
    assert.throws(() => store.confirmTest('test'), /submitted/);
    store.start('test');
    const queued = store.peek('test')!;
    store.claim('test', queued.id, 'authorized-test');
    store.finish(queued.id, 'SENT');
    store.confirmTest('test');
    assert.equal(store.hasConfirmedTest('account-a'), true);
    assert.equal(store.hasConfirmedTest('account-b'), false);
    assert.throws(() => store.bindAccount('test', 'account-b'), /different WhatsApp account/);
});

test('safe retry is scheduled durably and uses its original message ID', async context => {
    const store = memoryStore(context);
    store.importCampaign('retry', [row(1)]);
    store.start('retry');
    const queued = store.peek('retry')!;
    store.claim('retry', queued.id, 'stable-id');
    store.finish(queued.id, 'RETRY', 'Temporary local error before submission', Date.now() + 50);
    assert.equal(store.peek('retry'), undefined);
    const sent: string[] = [];
    await processWith(store, 'retry', { isReady: true, async send(message) { sent.push(message.id); } });
    assert.deepEqual(sent, ['stable-id']);
    assert.deepEqual(store.listAttempts('retry').map(item => item.state), ['RETRY', 'SENT']);
});
