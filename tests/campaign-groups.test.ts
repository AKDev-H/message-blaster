import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { backupDatabase, openDatabase } from '../src/database/connection.js';
import { initialMigration } from '../src/database/migrations/001-initial.js';
import { gmailMigration } from '../src/database/migrations/002-gmail.js';
import { webMigration } from '../src/database/migrations/003-web.js';
import { richScriptsMigration } from '../src/database/migrations/004-rich-scripts.js';
import { settingsMigration } from '../src/database/migrations/005-settings.js';
import { dropClientIdMigration } from '../src/database/migrations/006-drop-client-id.js';
import { authMigration } from '../src/database/migrations/007-auth.js';
import { CampaignExistsError, ConflictError } from '../src/errors.js';
import { Store, type PreparedRow } from '../src/store/index.js';
import type { CampaignChannel, MessageStatus } from '../src/types/index.js';

const people = [
    { rowNumber: 2, clientName: 'Ari', email: 'ari@example.com', phone: '+60123456789' },
    { rowNumber: 3, clientName: 'Ben', email: 'ben@example.com', phone: '' },
    { rowNumber: 4, clientName: 'Cy', email: '', phone: '+60123456788' },
];

function rows(channel: CampaignChannel): PreparedRow[] {
    return people.filter(person => (channel === 'gmail' ? person.email : person.phone)).map(person => ({
        rowNumber: person.rowNumber, clientName: person.clientName, phone: person.phone, email: person.email,
        subject: 'Hi', message: `Hello ${person.clientName}`, pdfFilename: '', consentStatus: 'Opted In',
    }));
}

function memory(context: TestContext) {
    const db = openDatabase(':memory:');
    context.after(() => db.close());
    return { db, store: new Store(db) };
}

function combined(store: Store, slug: string) {
    return store.createCampaignGroup({
        slug, name: slug, shared: { script: 'Hello', subject: 'Hi', attachment: '' },
        campaigns: (['gmail', 'whatsapp'] as const).map(channel => ({ id: `${slug}-${channel}`, channel, rows: rows(channel) })),
    });
}

function move(db: DatabaseSync, id: string, statuses: Partial<Record<MessageStatus, number>>) {
    const update = db.prepare(`UPDATE messages SET status = ? WHERE id IN (
        SELECT id FROM messages WHERE campaign_id = ? AND status = 'PENDING' ORDER BY row_number LIMIT ?)`);
    for (const [status, count] of Object.entries(statuses)) update.run(status, id, count);
}

test('a combined campaign counts each person once and each successful channel send separately', context => {
    const { db, store } = memory(context);
    combined(store, 'renewals');
    const group = store.campaignGroup('renewals');
    let members = store.groupMembers(group);
    assert.deepEqual(members.map(member => [member.id, member.channel]), [['renewals-gmail', 'gmail'], ['renewals-whatsapp', 'whatsapp']]);
    assert.equal(store.groupMetrics(group, members).people, 3, 'Ari is one person with two addresses');

    move(db, 'renewals-gmail', { SENT: 1, FAILED: 1 });
    move(db, 'renewals-whatsapp', { DELIVERED: 1, READ: 1 });
    members = store.groupMembers(group);
    const metrics = store.groupMetrics(group, members);
    assert.equal(metrics.peopleSent, 2, 'Ari reached on both channels counts once; Ben failed');
    assert.equal(metrics.completed, 3, 'delivered and read sends are successful sends');
    assert.equal(metrics.failed, 1);
    assert.equal(metrics.delivered, 2);
    assert.equal(metrics.read, 1);
    assert.equal(store.memberMetrics('renewals-whatsapp').completed, 2);
});

test('the campaign list shows one row per campaign, under either channel filter', context => {
    const { db, store } = memory(context);
    combined(store, 'renewals');
    store.importCampaign('newsletter', rows('gmail'), false, 'gmail');
    store.importCampaign('whatsapp-test', rows('whatsapp').slice(0, 1), true, 'whatsapp');
    move(db, 'renewals-whatsapp', { FAILED: 1 });

    const all = store.listGroupPage({ page: 1, pageSize: 10 });
    assert.deepEqual(all.groups.map(group => group.slug).sort(), ['newsletter', 'renewals'], 'test sends never appear');
    assert.equal(all.allCampaigns, 2);
    assert.deepEqual(all.groups.find(group => group.slug === 'renewals')?.channels, ['gmail', 'whatsapp']);
    assert.deepEqual(store.listGroupPage({ page: 1, pageSize: 10, channel: 'whatsapp' }).groups.map(group => group.slug), ['renewals']);
    assert.deepEqual(store.listGroupPage({ page: 1, pageSize: 10, channel: 'gmail' }).groups.map(group => group.slug).sort(), ['newsletter', 'renewals']);
    assert.deepEqual(store.listGroupPage({ page: 1, pageSize: 10, status: 'failed' }).groups.map(group => group.slug), ['renewals']);
    assert.deepEqual(store.listGroupPage({ page: 1, pageSize: 10, channel: 'gmail', status: 'failed' }).groups, [],
        'a channel filter looks only at that channel’s recipients');
});

test('campaign links are unique, survive a rename, and disappear with the last channel', context => {
    const { store } = memory(context);
    combined(store, 'renewals');
    assert.throws(() => combined(store, 'renewals'), CampaignExistsError);
    assert.throws(() => store.importCampaign('renewals', rows('gmail'), false, 'gmail'), CampaignExistsError, 'a single-channel import cannot take the link');
    assert.throws(() => store.importCampaign('renewals-gmail', rows('gmail'), false, 'gmail'), CampaignExistsError);

    store.renameGroup('renewals', 'Customer renewals — November');
    const renamed = store.campaignGroup('renewals');
    assert.equal(renamed.name, 'Customer renewals — November');

    store.deleteCampaign('renewals-gmail');
    assert.deepEqual(store.groupMembers(renamed).map(member => member.channel), ['whatsapp']);
    store.deleteGroup('renewals');
    assert.throws(() => store.campaignGroup('renewals'), /does not exist/u);
    assert.throws(() => store.getCampaign('renewals-whatsapp'), /does not exist/u);
});

test('a running channel blocks deleting its campaign', context => {
    const { store } = memory(context);
    combined(store, 'renewals');
    store.start('renewals-whatsapp');
    assert.throws(() => store.deleteGroup('renewals'), ConflictError);
    assert.doesNotThrow(() => store.campaignGroup('renewals'));
    assert.equal(store.getCampaign('renewals-gmail').state, 'Ready', 'the failed delete rolls back every channel');
});

test('upgrading keeps every campaign ID and its history, and only groups pairs someone confirms', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-groups-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const original = join(directory, 'v7.db');
    writeVersion7Database(original);
    const copy = join(directory, 'copy.db');
    await copyFile(original, copy);

    using db = openDatabase(copy);
    const store = new Store(db);
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), 8);
    const listed = store.listGroupPage({ page: 1, pageSize: 10 }).groups.map(group => group.slug).sort();
    assert.deepEqual(listed, ['launch-gmail', 'launch-whatsapp', 'news', 'promo-gmail', 'promo-whatsapp'], 'each campaign is listed on its own until grouped');
    assert.equal(db.prepare('SELECT group_id FROM campaigns WHERE id = ?').get('gmail-test-1')?.group_id, null);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM messages').get()?.n), 5);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM message_attempts').get()?.n), 1);
    assert.equal(store.listMessages('launch-gmail')[0]?.status, 'SENT');

    const pairs = store.pairCandidates();
    assert.deepEqual(pairs.map(pair => [pair.slug, pair.sameWorkbook, pair.createdTogether]), [
        ['launch', true, true],
        ['promo', false, false],
    ]);
    assert.throws(() => store.groupPair('promo-gmail', 'promo-whatsapp', 'promo'), ConflictError, 'matching names alone are not evidence');
    assert.equal(store.listGroupPage({ page: 1, pageSize: 10 }).allCampaigns, 5, 'the report changes nothing');

    const group = store.groupPair('launch-gmail', 'launch-whatsapp', 'launch');
    assert.equal(group.contactIdentity, 'row');
    assert.deepEqual(store.groupMembers(group).map(member => member.id), ['launch-gmail', 'launch-whatsapp']);
    assert.equal(store.listGroupPage({ page: 1, pageSize: 10 }).allCampaigns, 4);
    assert.equal(store.groupMetrics(group, store.groupMembers(group)).peopleSent, 1);
    assert.throws(() => store.campaignGroup('launch-gmail'), /does not exist/u);

    const restored = join(directory, 'restored.db');
    await backupDatabase(db, restored);
    using backup = openDatabase(restored);
    assert.deepEqual(new Store(backup).groupMembers(new Store(backup).campaignGroup('launch')).map(member => member.id), ['launch-gmail', 'launch-whatsapp']);
    using untouched = new DatabaseSync(original);
    assert.equal(Number(untouched.prepare('PRAGMA user_version').get()?.user_version), 7, 'the original file is never migrated in place by the check');
});

function writeVersion7Database(path: string): void {
    using db = new DatabaseSync(path);
    for (const sql of [initialMigration, gmailMigration, webMigration, richScriptsMigration, settingsMigration, dropClientIdMigration, authMigration]) db.exec(sql);
    db.exec('PRAGMA user_version = 7');
    const campaign = db.prepare('INSERT INTO campaigns(id, state, is_test, created_at, updated_at, channel) VALUES (?, ?, ?, ?, ?, ?)');
    const message = db.prepare(`INSERT INTO messages(campaign_id, row_number, client_id, client_name, recipient, message, pdf_filename,
        consent_status, eligible, status, attempt_count) VALUES (?, ?, '', ?, ?, 'Hello', '', 'Opted In', 1, ?, ?)`);
    const draft = db.prepare("INSERT INTO web_campaign_drafts(campaign_id, workbook, script, subject, attachment) VALUES (?, ?, 'Hello', '', '')");
    campaign.run('news', 'Ready', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'gmail');
    message.run('news', 2, 'Ari', 'ari@example.com', 'PENDING', 0);
    for (const [id, channel, address] of [['launch-gmail', 'gmail', 'ari@example.com'], ['launch-whatsapp', 'whatsapp', '+60123456789']] as const) {
        campaign.run(id, 'Completed', 0, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', channel);
        message.run(id, 2, 'Ari', address, id === 'launch-gmail' ? 'SENT' : 'FAILED', 1);
        draft.run(id, Buffer.from('same workbook'));
    }
    db.exec("INSERT INTO message_attempts(message_id, attempt_number, transport_message_id, state, started_at) VALUES (2, 1, 'smtp-1', 'SENT', '2026-02-01T00:00:01.000Z')");
    campaign.run('promo-gmail', 'Ready', 0, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'gmail');
    message.run('promo-gmail', 2, 'Ben', 'ben@example.com', 'PENDING', 0);
    draft.run('promo-gmail', Buffer.from('march list'));
    campaign.run('promo-whatsapp', 'Ready', 0, '2026-04-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z', 'whatsapp');
    message.run('promo-whatsapp', 2, 'Cy', '+60123456788', 'PENDING', 0);
    draft.run('promo-whatsapp', Buffer.from('april list'));
    campaign.run('gmail-test-1', 'Completed', 1, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'gmail');
}
