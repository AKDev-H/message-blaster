import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { DEFAULT_SETTINGS, loadEnv } from '../src/config/env.js';
import { openDatabase } from '../src/database/connection.js';
import { startWebServer } from '../src/web/server.js';
import { approveTestUser, authenticatedFetch, mockGoogle, testLogin } from './support/web-auth.js';

interface Channel {
    id: string;
    channel: string;
    state: string;
    draft: { script: string; subject: string; overrides?: string[] } | null;
    actions: Record<string, unknown>;
}

interface Detail {
    campaign: { slug: string; name: string; version: string; channels: string[]; sendBoth: boolean };
    metrics: { people: number; peopleSent: number };
    channels: Channel[];
    draft: { shared: { script: string; subject: string } } | null;
}

async function workbook(): Promise<Blob> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Clients');
    sheet.addRow(['Client Name', 'Email Address', 'Phone Number', 'Subject', 'Message', 'PDF Filename', 'Consent Status', 'Campaign ID']);
    sheet.addRow(['Ari', 'ari@example.com', '+60123456789', '', '', '', 'Opted In', '']);
    sheet.addRow(['Ben', 'ben@example.com', '', '', '', '', 'Opted In', '']);
    sheet.addRow(['Cy', '', '+60123456788', '', '', '', 'Opted In', '']);
    sheet.addRow(['Dee', 'dee@example.com', '+60123456787', '', '', '', 'Withdrawn', '']);
    return new Blob([await book.xlsx.writeBuffer()]);
}

test('one campaign page per link, with shared content, per-channel overrides and locked channels', { timeout: 30_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-groups-web-'));
    const env = {
        ...loadEnv(), ...DEFAULT_SETTINGS, DATABASE_URL: join(directory, 'app.db'), ATTACHMENTS_DIR: join(directory, 'files'),
        LOG_DIR: join(directory, 'logs'), DRY_RUN: true, MAINTENANCE_MODE: false,
    };
    approveTestUser(env.DATABASE_URL);
    const dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    context.after(async () => {
        await dashboard.close();
        await rm(directory, { recursive: true, force: true });
    });
    const request = authenticatedFetch(dashboard.url, await testLogin(dashboard.url));
    const detail = async (slug = 'renewals') => (await (await request(`/api/campaign-groups/${slug}`)).json()) as Detail;
    const rows = async (channel: string) => (await (await request(`/api/campaign-groups/renewals/${channel}`)).json()) as {
        rows: { clientName: string; message: string; subject?: string; status: string }[];
    };

    const form = new FormData();
    form.set('id', 'renewals');
    form.append('channel', 'whatsapp');
    form.append('channel', 'gmail');
    form.set('script', 'Hello {{client_name}}');
    form.set('subject', 'Your renewal');
    form.set('whatsapp.script', 'Hi {{client_name}} on {{phone_number}}');
    form.set('whatsapp.scriptHtml', '<p>Hi {{client_name}} <script>alert(1)</script>on {{phone_number}}</p>');
    form.set('workbook', await workbook(), 'clients.xlsx');
    const created = await request('/api/campaign-groups', { method: 'POST', body: form });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { slug: 'renewals', id: 'renewals-gmail', ids: ['renewals-gmail', 'renewals-whatsapp'] });

    const list = await (await request('/api/campaign-groups')).json() as { campaigns: { slug: string; channels: string[] }[] };
    assert.deepEqual(list.campaigns.map(item => [item.slug, item.channels]), [['renewals', ['gmail', 'whatsapp']]]);

    let shown = await detail();
    assert.deepEqual(shown.channels.map(channel => channel.id), ['renewals-gmail', 'renewals-whatsapp']);
    assert.equal(shown.metrics.people, 3, 'Dee withdrew consent, so three people can be messaged');
    assert.equal(shown.draft?.shared.script, 'Hello {{client_name}}');
    assert.deepEqual(shown.channels.map(channel => channel.draft?.overrides ?? []), [[], ['message']]);
    assert.deepEqual((await rows('gmail')).rows.filter(row => row.status !== 'SKIPPED').map(row => [row.clientName, row.message, row.subject]),
        [['Ari', 'Hello Ari', 'Your renewal'], ['Ben', 'Hello Ben', 'Your renewal']]);
    const whatsapp = (await rows('whatsapp')).rows;
    assert.deepEqual(whatsapp.filter(row => row.status !== 'SKIPPED').map(row => row.message), ['Hi Ari on +60123456789', 'Hi Cy on +60123456788']);
    assert.ok(whatsapp.every(row => !row.message.includes('alert')), 'per-channel rich text is sanitized');

    const reset = new FormData();
    reset.set('script', 'Welcome back {{client_name}}');
    reset.set('subject', 'Renewal time');
    reset.set('gmail.subject', 'Gmail only: renew today');
    assert.equal((await request('/api/campaign-groups/renewals/draft', { method: 'PUT', body: reset })).status, 200);
    shown = await detail();
    assert.deepEqual(shown.channels.map(channel => channel.draft?.overrides ?? []), [['subject'], []], 'WhatsApp is back on the shared message');
    assert.equal((await rows('gmail')).rows[0]?.subject, 'Gmail only: renew today');
    assert.equal((await rows('whatsapp')).rows[0]?.message, 'Welcome back Ari');

    const stale = shown.campaign.version;
    using db = openDatabase(env.DATABASE_URL);
    db.prepare("UPDATE campaigns SET state = 'Paused', account_id = 'gmail:sender@example.com' WHERE id = 'renewals-gmail'").run();
    shown = await detail();
    assert.notEqual(shown.campaign.version, stale);
    assert.equal(shown.channels[0]?.draft, null, 'a channel that has started is locked');
    const locked = new FormData();
    locked.set('script', 'Changed for everyone');
    locked.set('subject', 'Changed subject');
    const edited = await request('/api/campaign-groups/renewals/draft', { method: 'PUT', body: locked });
    assert.deepEqual(await edited.json(), { slug: 'renewals', channels: ['whatsapp'] });
    assert.equal((await rows('gmail')).rows[0]?.subject, 'Gmail only: renew today', 'the started channel keeps its content');
    assert.equal((await rows('whatsapp')).rows[0]?.message, 'Changed for everyone');

    const send = (body: object) => request('/api/campaign-groups/renewals/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.match(((await (await send({ channels: ['gmail', 'whatsapp'], approve: 'renewals', version: stale })).json()) as { error: string }).error,
        /changed since you opened it/u, 'a stale tab cannot send');
    const preview = await send({ channels: ['gmail', 'whatsapp'], approve: 'renewals', version: (await detail()).campaign.version });
    assert.equal(preview.status, 409);
    assert.match(((await preview.json()) as { error: string }).error, /DRY_RUN/u);

    assert.equal((await request('/api/campaign-groups/renewals', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Customer renewals' }),
    })).status, 200);
    assert.equal((await detail()).campaign.name, 'Customer renewals');
    assert.equal((await request('/campaigns/renewals', { headers: { Accept: 'text/html' } })).status, 200, 'the link survives a rename');

    const exported = await request('/api/campaign-groups/renewals/whatsapp/export');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') ?? '', /renewals-whatsapp-results\.xlsx/u);
    for (const path of ['/campaigns/unknown', '/campaigns/bad%20slug!', '/campaigns/%E0%A4%A']) {
        assert.equal((await request(path, { headers: { Accept: 'text/html' } })).status, 404, path);
    }
    assert.equal((await request('/api/campaign-groups/renewals/telegram')).status, 404);
    assert.equal((await request('/api/campaign-groups/missing')).status, 404);
    for (const path of ['/campaigns/renewals', '/api/campaign-groups/renewals', '/api/campaign-groups/renewals/gmail/export']) {
        const anonymous = await fetch(`${dashboard.url}${path}`, { redirect: 'manual' });
        assert.ok([303, 401].includes(anonymous.status), `${path} requires sign-in`);
    }

    const duplicate = new FormData();
    duplicate.set('id', 'renewals');
    duplicate.set('channel', 'gmail');
    duplicate.set('subject', 'Hi');
    duplicate.set('script', 'Hello');
    duplicate.set('workbook', await workbook(), 'clients.xlsx');
    assert.equal((await request('/api/campaign-groups', { method: 'POST', body: duplicate })).status, 409, 'links are unique');
    const noPhones = new FormData();
    noPhones.set('id', 'email-only');
    noPhones.append('channel', 'gmail');
    noPhones.append('channel', 'whatsapp');
    noPhones.set('subject', 'Hi');
    noPhones.set('script', 'Hello');
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Clients').addRows([['Client Name', 'Email Address', 'Phone Number', 'Subject', 'Message', 'PDF Filename', 'Consent Status', 'Campaign ID'],
        ['Ari', 'ari@example.com', '', '', '', '', 'Opted In', '']]);
    noPhones.set('workbook', new Blob([await book.xlsx.writeBuffer()]), 'emails.xlsx');
    const refused = await request('/api/campaign-groups', { method: 'POST', body: noPhones });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /phone number for WhatsApp/u);
    assert.equal((await request('/api/campaign-groups/email-only')).status, 404, 'a failed save leaves no half campaign behind');

    db.prepare("UPDATE campaigns SET state = 'Ready', account_id = NULL WHERE id = 'renewals-gmail'").run();
    assert.equal((await request('/api/campaign-groups/renewals', { method: 'DELETE' })).status, 204);
    assert.equal((await request('/campaigns/renewals', { headers: { Accept: 'text/html' } })).status, 404, 'deleted campaigns show the 404 page');
});
