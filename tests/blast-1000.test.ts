import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import pino from 'pino';
import { openDatabase } from '../src/database/connection.js';
import { prepareRows } from '../src/services/campaign/prepare-rows.js';
import type { ImportRow } from '../src/services/excel/columns.js';
import { Store } from '../src/store/index.js';
import type { MessageTransport, OutgoingMessage } from '../src/types/index.js';
import { runCampaign } from '../src/workers/campaign.worker.js';

const logger = pino({ level: 'silent' });
const CUSTOMERS = 1_000;
const settings = {
    ATTACHMENTS_DIR: './tests/fixtures',
    MAX_MESSAGES_PER_RUN: 5_000,
    MESSAGE_DELAY_MS: 0,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 100,
    SENDER_CONCURRENCY: 1,
};

function memoryStore(context: TestContext) {
    const db = openDatabase(':memory:');
    context.after(() => db.close());
    return new Store(db);
}

function phoneFor(index: number): string {
    return `01${String(20_000_000 + index).padStart(8, '0')}`;
}

function customerList(campaignId: string): ImportRow[] {
    return Array.from({ length: CUSTOMERS }, (_, index) => {
        const row = index + 2;
        let phone = phoneFor(index);
        if (index % 100 === 99) phone = phoneFor(index - 1);
        if (index % 200 === 7) phone = '12';
        return {
            rowNumber: row,
            clientName: `Customer ${index + 1}`,
            phone,
            message: '',
            pdfFilename: '',
            consentStatus: index % 50 === 3 ? 'Not Opted In' : 'Opted In',
            campaignId,
        };
    });
}

async function importBlast(store: Store, id: string) {
    const prepared = await prepareRows(store, { ...settings, DEFAULT_COUNTRY: 'MY' }, id, customerList(id), 'Hi {{client_name}}, our sale starts today!');
    store.importCampaign(id, prepared);
    store.start(id);
}

function fakeWhatsApp(store: Store, options: { latencyMs?: number; failEvery?: number } = {}) {
    const sent: OutgoingMessage[] = [];
    const startedAt: number[] = [];
    const transport: MessageTransport & { isReady: boolean } = {
        isReady: true,
        async waitUntilReady() {
            while (!transport.isReady) await new Promise(resolve => setTimeout(resolve, 5));
        },
        async send(message) {
            startedAt.push(performance.now());
            sent.push(message);
            await new Promise(resolve => setTimeout(resolve, options.latencyMs ?? 0));
            if (options.failEvery && sent.length % options.failEvery === 0) throw new Error('socket closed mid-send');
            store.receipt(message.id, sent.length % 3 === 0 ? 'READ' : 'DELIVERED');
            return { acknowledged: true };
        },
    };
    return { transport, sent, startedAt };
}

function countBy(store: Store, id: string) {
    const counts: Record<string, number> = {};
    for (const message of store.listMessages(id)) counts[message.status] = (counts[message.status] ?? 0) + 1;
    return counts;
}

const run = (store: Store, id: string, transport: MessageTransport, overrides = {}) =>
    runCampaign(store, id, { ...settings, ...overrides }, transport, logger, new AbortController().signal);

test('1,000 customers: every eligible customer gets exactly one message and bad rows are skipped', async context => {
    const store = memoryStore(context);
    await importBlast(store, 'blast');
    const eligible = store.listMessages('blast').filter(message => message.eligible).length;
    const fake = fakeWhatsApp(store, { latencyMs: 1, failEvery: 250 });

    const began = performance.now();
    const attempts = await run(store, 'blast', fake.transport);
    const seconds = (performance.now() - began) / 1_000;

    const counts = countBy(store, 'blast');
    const phones = fake.sent.map(message => message.phone);
    console.log(`\n  1,000-customer mock blast
    rows imported      ${CUSTOMERS}
    eligible           ${eligible}
    skipped            ${counts.SKIPPED ?? 0} (duplicates, no consent, bad numbers)
    sent to WhatsApp   ${fake.sent.length}
    delivered / read   ${counts.DELIVERED ?? 0} / ${counts.READ ?? 0}
    needs review       ${counts.UNKNOWN ?? 0}
    app overhead       ${seconds.toFixed(2)} s total, ${(seconds * 1_000 / attempts).toFixed(2)} ms per message
    real run at 10 s   ~${Math.round(eligible * 10 / 60)} min (set by MESSAGE_DELAY_MS, not the app)\n`);

    assert.equal(store.getCampaign('blast').state, 'Completed');
    assert.equal(attempts, eligible);
    assert.equal(new Set(phones).size, phones.length, 'no customer is messaged twice');
    assert.equal(counts.SKIPPED, CUSTOMERS - eligible);
    assert.equal(counts.UNKNOWN, Math.floor(eligible / 250), 'lost sends are flagged for review, never resent');
    assert.equal((counts.DELIVERED ?? 0) + (counts.READ ?? 0) + (counts.UNKNOWN ?? 0), eligible);
    assert.ok(store.listMessages('blast').every(message => message.status !== 'SENT' || message.eligible));
    assert.match(fake.sent[0]!.text, /^Hi Customer 1, our sale starts today!$/u);
});

test('the default 100-per-run cap pauses a 1,000 blast; resuming finishes it with no repeats', async context => {
    const store = memoryStore(context);
    await importBlast(store, 'capped');
    const eligible = store.listMessages('capped').filter(message => message.eligible).length;
    const fake = fakeWhatsApp(store);

    let runs = 0;
    for (;;) {
        runs += 1;
        assert.ok((await run(store, 'capped', fake.transport, { MAX_MESSAGES_PER_RUN: 100 })) <= 100);
        if (store.getCampaign('capped').state === 'Completed') break;
        assert.equal(store.getCampaign('capped').state, 'Paused');
        store.resume('capped');
    }

    assert.equal(runs, Math.ceil(eligible / 100));
    assert.equal(new Set(fake.sent.map(message => message.phone)).size, eligible);
});

test('pacing: the delay is kept between sends even with several senders', async context => {
    const store = memoryStore(context);
    await importBlast(store, 'paced');
    const fake = fakeWhatsApp(store, { latencyMs: 30 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);

    await runCampaign(store, 'paced', { ...settings, MESSAGE_DELAY_MS: 40, SENDER_CONCURRENCY: 3 }, fake.transport, logger, controller.signal);

    const gaps = fake.startedAt.slice(1).map((time, index) => time - fake.startedAt[index]!);
    assert.ok(fake.sent.length >= 5, `sent ${fake.sent.length}`);
    assert.ok(Math.min(...gaps) >= 38, `smallest gap ${Math.min(...gaps).toFixed(1)} ms`);
});

test('a dropped WhatsApp connection mid-blast waits, reconnects and continues without duplicates', async context => {
    const store = memoryStore(context);
    await importBlast(store, 'flaky');
    const eligible = store.listMessages('flaky').filter(message => message.eligible).length;
    const fake = fakeWhatsApp(store);
    const send = fake.transport.send.bind(fake.transport);
    fake.transport.send = async message => {
        const result = await send(message);
        if (fake.sent.length % 300 === 0) {
            fake.transport.isReady = false;
            setTimeout(() => { fake.transport.isReady = true; }, 50);
        }
        return result;
    };

    await run(store, 'flaky', fake.transport);

    assert.equal(store.getCampaign('flaky').state, 'Completed');
    assert.equal(fake.sent.length, eligible);
    assert.equal(new Set(fake.sent.map(message => message.phone)).size, eligible);
});
