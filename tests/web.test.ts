import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import type { AuditEvent } from '../src/auth/store.js';
import { openDatabase } from '../src/database/connection.js';
import { Store } from '../src/store/index.js';
import { saveSettings } from '../src/services/settings.service.js';
import { startWebServer } from '../src/web/server.js';
import { testEnvironment } from './support/environment.js';
import { approveTestUser, authenticatedFetch, mockGoogle, testLogin } from './support/web-auth.js';

interface CampaignProgress {
    id: string;
    state: string;
    runActive?: boolean;
    processing: number;
    completed: number;
    failed: number;
    unknown: number;
    queued: number;
    skipped: number;
}

async function watchProgress(request: ReturnType<typeof authenticatedFetch>, cleanup: (callback: () => void) => void) {
    const abort = new AbortController();
    cleanup(() => abort.abort());
    const stream = await request('/api/events', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]) });
    assert.equal(stream.status, 200);
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    return async (match: (campaign: CampaignProgress) => boolean) => {
        for (;;) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary !== -1) {
                const data = buffer.slice(0, boundary).split('\n').find(line => line.startsWith('data: '));
                buffer = buffer.slice(boundary + 2);
                if (data) {
                    const response = await request('/api/campaign-groups/outreach/gmail');
                    const campaign = response.ok ? ((await response.json()) as { campaign: CampaignProgress }).campaign : undefined;
                    if (campaign && match(campaign)) return campaign;
                }
                continue;
            }
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Progress stream ended before the expected update.');
            buffer += chunk.value;
        }
    };
}

test('dashboard uploads, edits, streams progress, pauses, retries, cancels and deletes with a simulated sender', { timeout: 30_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-web-'));
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const mockPath = join(directory, 'smtp.mjs');
    const failedOnce = join(directory, 'failed-once');
    const releaseFirst = join(directory, 'release-first');
    await writeFile(mockPath, `
        import nodemailer from ${JSON.stringify(import.meta.resolve('nodemailer'))};
        import { access, writeFile } from 'node:fs/promises';
        import { setTimeout } from 'node:timers/promises';
        nodemailer.createTransport = () => ({
            verify: async () => true,
            sendMail: async message => {
                if (message.to === 'ari@example.com') {
                    for (let poll = 0; !await access(${JSON.stringify(releaseFirst)}).then(() => true, () => false); poll++) {
                        if (poll === 200) throw new Error('The test did not release the first submission');
                        await setTimeout(50);
                    }
                }
                if (message.to === 'retry@example.com') {
                    try {
                        await writeFile(${JSON.stringify(failedOnce)}, '', { flag: 'wx' });
                        throw new Error('Simulated lost SMTP response');
                    } catch (error) {
                        if (error.code !== 'EEXIST') throw error;
                    }
                }
                return { accepted: [message.to] };
            },
        });
    `);
    const importMock = `--import=${pathToFileURL(mockPath).href}`;
    process.env.NODE_OPTIONS = [originalNodeOptions, importMock].filter(Boolean).join(' ');
    const env = testEnvironment(directory, {
        SECRET_KEY_FILE: join(directory, 'secret.key'),
        GMAIL_USER: 'sender@example.com',
        GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
        DRY_RUN: false,
        SENDER_CONCURRENCY: 1,
        MAX_MESSAGES_PER_RUN: 100,
        MESSAGE_DELAY_MS: 100,
    });
    {
        using db = openDatabase(env.DATABASE_URL);
        saveSettings(db, env, { GMAIL_USER: env.GMAIL_USER, GMAIL_APP_PASSWORD: env.GMAIL_APP_PASSWORD, MESSAGE_DELAY_MS: env.MESSAGE_DELAY_MS });
        const store = new Store(db);
        store.importCampaign('test-setup', [{
            rowNumber: 1, clientName: 'Test', phone: '', email: 'test@example.com',
            subject: 'Test', message: 'Test', pdfFilename: '', consentStatus: 'Opted In',
        }], true, 'gmail');
        store.bindAccount('test-setup', 'gmail:sender@example.com');
        store.start('test-setup');
        const record = store.peek('test-setup')!;
        store.claim('test-setup', record.id, 'test-setup-message');
        store.finish(record.id, 'SENT');
        store.settleCampaign('test-setup');
        store.confirmTest('test-setup');
    }

    let dashboard: Awaited<ReturnType<typeof startWebServer>> | undefined;
    let stopProgress: (() => void) | undefined;
    context.after(async () => {
        stopProgress?.();
        await dashboard?.close();
        if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = originalNodeOptions;
        await rm(directory, { recursive: true, force: true });
    });
    approveTestUser(env.DATABASE_URL);
    dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    const { url } = dashboard;
    const request = authenticatedFetch(url, await testLogin(url));
    const group = (slug = 'outreach') => `/api/campaign-groups/${slug}`;
    const channel = (slug = 'outreach') => `${group(slug)}/gmail`;
    const version = async (slug: string) => ((await (await request(group(slug))).json()) as { campaign: { version: string } }).campaign.version;
    const command = async (action: string, body: Record<string, unknown> = {}, slug = 'outreach') => request(`${channel(slug)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['start', 'resume'].includes(action) ? { version: await version(slug), ...body } : body),
    });
    assert.equal((await request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
    assert.equal((await request('/api/campaign-groups', { headers: { Origin: 'https://example.com' } })).status, 403);

    const sample = await request('/api/template?channel=gmail');
    assert.match(sample.headers.get('content-disposition') ?? '', /gmail-sample\.xlsx/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await sample.arrayBuffer());
    const sheet = workbook.worksheets[0]!;
    assert.equal(sheet.getCell('B1').value, 'Email Address');
    assert.equal(sheet.getCell('E1').value, 'Attachment');
    assert.equal(sheet.actualRowCount, 1, 'the dashboard template has headers only');
    sheet.addRow(['Ari', 'ari@example.com', '', '', '', 'Opted In']);
    sheet.addRow(['Ben', 'retry@example.com', '', '', '', 'Opted In']);
    sheet.addRow(['Casey', 'casey@example.com', '', '', '', 'Opted In']);

    const pdf = new FormData();
    pdf.set('file', new Blob([Uint8Array.from(await readFile('tests/fixtures/sample-document.pdf'))]), 'sales.pdf');
    assert.equal((await request('/api/attachments', { method: 'POST', body: pdf })).status, 201);
    assert.equal((await request('/api/attachments', { method: 'POST', body: pdf })).status, 409);
    const invalidUpload = await request('/api/attachments', {
        method: 'POST',
        body: 'not multipart',
        headers: { 'content-type': 'text/plain' },
    });
    assert.equal(invalidUpload.status, 415);

    const upload = new FormData();
    upload.set('id', 'outreach');
    upload.set('channel', 'gmail');
    upload.set('script', 'Hello {{client_name}}');
    upload.set('subject', 'Your brochure');
    upload.set('attachment', 'sales.pdf');
    upload.set('workbook', new Blob([await workbook.xlsx.writeBuffer()]), 'clients.xlsx');

    const readProgress = await watchProgress(request, callback => { stopProgress = callback; });
    assert.equal((await request('/api/campaign-groups', { method: 'POST', body: upload })).status, 201);
    const edit = new FormData();
    edit.set('script', 'Hi {{client_name}}, here is your updated brochure.');
    edit.set('subject', 'New brochure');
    edit.set('attachment', 'sales.pdf');
    assert.equal((await request(`${group()}/draft`, { method: 'PUT', body: edit })).status, 200);
    const before = await (await request(channel())).json();
    assert.equal(before.rows[0].message, 'Hi Ari, here is your updated brochure.');
    assert.equal(before.rows[0].pdfFilename, 'sales.pdf');
    assert.equal(before.rows[0].subject, 'New brochure');
    await readProgress(item => item.state === 'Ready' && item.queued === 3);

    assert.equal((await command('start', { approve: 'wrong' })).status, 409);
    assert.equal((await command('start', { approve: 'outreach' })).status, 202);
    await readProgress(item => item.processing === 1);
    assert.equal((await command('pause')).status, 200);
    assert.equal((await request(group(), { method: 'DELETE' })).status, 409);
    await writeFile(releaseFirst, '');
    const paused = await readProgress(item => item.state === 'Paused' && !item.runActive && item.processing === 0);
    assert.equal(paused.completed, 1);
    assert.equal(paused.queued, 2);
    assert.equal((await request(`${group()}/draft`, { method: 'PUT', body: edit })).status, 409);

    assert.equal((await command('resume', { approve: 'outreach' })).status, 202);
    const finished = await readProgress(item => item.state === 'Completed' && !item.runActive);
    assert.equal(finished.completed, 2);
    assert.equal(finished.unknown, 1);
    assert.equal((await command('retry')).status, 409);
    const after = await (await request(channel())).json();
    const unknown = after.rows.find((row: { status: string }) => row.status === 'UNKNOWN');
    assert.equal((await command('review', { recordId: unknown.id, outcome: 'FAILED', note: 'Verified in the simulated sender.' })).status, 200);
    assert.equal((await command('retry')).status, 200);
    assert.equal((await command('resume', { approve: 'outreach' })).status, 202);
    const retried = await readProgress(item => item.completed === 3 && !item.runActive);
    assert.equal(retried.failed, 0);
    assert.equal((await request(`${channel()}/export`)).status, 200);
    assert.equal((await request(group(), { method: 'DELETE' })).status, 204);
    assert.equal((await request(group())).status, 404);

    upload.set('id', 'cancel-test');
    assert.equal((await request('/api/campaign-groups', { method: 'POST', body: upload })).status, 201);
    assert.equal((await command('start', { approve: 'cancel-test' }, 'cancel-test')).status, 202);
    assert.equal((await command('cancel', {}, 'cancel-test')).status, 200);
    const cancelled = await (await request(channel('cancel-test'))).json();
    assert.equal(cancelled.campaign.state, 'Cancelled');
    assert.equal(cancelled.campaign.skipped, 3);

    for (const asset of ['/campaigns/queue.mjs', '/compose/composer.mjs', '/dialogs/confirm.mjs', '/editor/editor.mjs', '/shared/ui.mjs']) {
        assert.equal((await request(asset)).status, 200, asset);
    }

    const duplicate = await request('/api/campaign-groups', { method: 'POST', body: upload });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).field, 'id');

    upload.set('id', 'rich-script');
    upload.set('script', 'ignored when formatted');
    upload.set('scriptHtml', '<p>Hi <b>{{client_name}}</b></p><script>alert(1)</script><ul><li onclick="x()">Fast</li></ul>');
    assert.equal((await request('/api/campaign-groups', { method: 'POST', body: upload })).status, 201);
    const rich = await (await request(channel('rich-script'))).json();
    const richDraft = await (await request(group('rich-script'))).json();
    assert.equal(richDraft.draft.shared.scriptHtml, '<p>Hi <b>{{client_name}}</b></p><ul><li>Fast</li></ul>');
    assert.equal(rich.rows[0].messageHtml, '<p>Hi <b>Ari</b></p><ul><li>Fast</li></ul>');
    assert.match(rich.rows[0].message, /^Hi Ari\n+ \* Fast$/u);

    const combinedSample = new ExcelJS.Workbook();
    await combinedSample.xlsx.load(await (await request('/api/template?channel=both')).arrayBuffer());
    const combinedSheet = combinedSample.worksheets[0]!;
    const headers = (combinedSheet.getRow(1).values as unknown[]).filter(Boolean);
    assert.ok(headers.includes('Email Address') && headers.includes('Phone Number'));
    assert.equal(combinedSheet.actualRowCount, 1);
    combinedSheet.addRow(['Ari', 'ari@example.com', '+60123456789', 'Hello', '', '', 'Opted In']);
    combinedSheet.addRow(['Ben', 'ben@example.com', '', 'Hello', '', '', 'Opted In']);
    const both = new FormData();
    both.set('id', 'launch');
    both.append('channel', 'gmail');
    both.append('channel', 'whatsapp');
    both.set('script', 'Hi {{client_name}}');
    both.set('workbook', new Blob([await combinedSample.xlsx.writeBuffer()]), 'both.xlsx');
    const created = await request('/api/campaign-groups', { method: 'POST', body: both });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).ids, ['launch-gmail', 'launch-whatsapp']);
    assert.equal((await (await request(channel('launch'))).json()).campaign.total, 2);
    const whatsapp = await (await request(`${group('launch')}/whatsapp`)).json();
    assert.equal(whatsapp.campaign.total, 1);
    assert.equal(whatsapp.rows[0].message, 'Hi Ari');

    both.set('id', 'launch');
    assert.equal((await request('/api/campaign-groups', { method: 'POST', body: both })).status, 409);
    both.delete('channel');
    const missing = await request('/api/campaign-groups', { method: 'POST', body: both });
    assert.equal((await missing.json()).field, 'channel');

    const put = (path: string, body: unknown) => request(path, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const badGmail = await put('/api/settings/gmail', { user: 'sender@gmail.com', password: 'short' });
    assert.equal((await badGmail.json()).field, 'gmailPassword');
    const savedGmail = await (await put('/api/settings/gmail', { user: 'Sender@Gmail.com', password: 'abcd efgh ijkl mnop' })).json();
    assert.equal(savedGmail.gmail.user, 'sender@gmail.com');
    assert.equal(savedGmail.gmail.passwordSet, true);
    assert.equal(savedGmail.gmail.test.account, 'gmail:sender@gmail.com');
    assert.doesNotMatch(JSON.stringify(savedGmail), /abcdefghijklmnop/u);
    {
        using db = openDatabase(env.DATABASE_URL);
        const stored = String(db.prepare("SELECT value FROM settings WHERE key = 'GMAIL_APP_PASSWORD'").get()?.value);
        assert.match(stored, /^enc:v1:/u);
        assert.doesNotMatch(stored, /abcdefghijklmnop/u);
    }
    const other = await (await put('/api/settings/gmail', { user: 'other@gmail.com', password: '' })).json();
    assert.equal(other.gmail.test.confirmed, false, 'a new sender address needs its own confirmed test');

    const post = (path: string, body: unknown = {}) => request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await (await post('/api/settings/gmail/test', { recipient: '' })).json()).field, 'testRecipient');
    assert.equal((await post('/api/settings/gmail/test/confirm')).status, 409, 'the latest test belongs to another sender');
    assert.equal((await post('/api/settings/gmail/test', { recipient: 'me@example.com' })).status, 200);
    let tested = await (await request('/api/settings')).json();
    for (let attempt = 0; tested.gmail.test.latest.phase === 'sending' && attempt < 100; attempt++) {
        await setTimeout(100);
        tested = await (await request('/api/settings')).json();
    }
    assert.equal(tested.gmail.test.latest.phase, 'sent', tested.gmail.test.latest.error);
    assert.equal(tested.gmail.test.latest.recipient, 'me@example.com');
    const confirmed = await (await post('/api/settings/gmail/test/confirm')).json();
    assert.equal(confirmed.gmail.test.confirmed, true);
    assert.ok(!(await (await request('/api/campaign-groups')).json()).campaigns.some((campaign: { isTest: boolean }) => campaign.isTest),
        'test sends stay out of the campaign list');
    const sending = await (await put('/api/settings/sending', { country: 'sg', delaySeconds: 2.5 })).json();
    assert.deepEqual(sending.sending, { country: 'SG', delaySeconds: 2.5 });
    assert.equal(sending.whatsapp.status, 'unlinked');
    assert.equal((await (await put('/api/settings/sending', { country: 'XX', delaySeconds: 1 })).json()).field, 'country');

    const note = new FormData();
    note.set('file', new Blob(['Quarterly notes']), 'notes.txt');
    assert.equal((await request('/api/attachments', { method: 'POST', body: note })).status, 201);
    const blocked = new FormData();
    blocked.set('file', new Blob(['MZ']), 'setup.exe');
    assert.equal((await request('/api/attachments', { method: 'POST', body: blocked })).status, 400);
    const listed = await (await request('/api/attachments')).json();
    assert.deepEqual(listed.files.map((file: { name: string }) => file.name), ['notes.txt', 'sales.pdf']);
    const served = await request('/api/attachments/notes.txt');
    assert.equal(await served.text(), 'Quarterly notes');
    assert.match(served.headers.get('content-type') ?? '', /^text\/plain/u);
    assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/u);
    assert.match((await request('/api/attachments/notes.txt?download')).headers.get('content-disposition') ?? '', /^attachment/u);
    assert.equal((await request('/api/attachments/missing.pdf')).status, 404);
    assert.equal((await request('/api/attachments/..%2Fsecret.txt')).status, 404);

    const { events } = await (await request('/api/audit')).json() as { events: AuditEvent[] };
    const start = events.find(event => event.action === 'campaign.start' && event.target === 'outreach/gmail');
    assert.equal(start?.outcome, 'accepted');
    assert.ok(events.some(event => event.source === 'worker' && event.action === 'campaign.worker_exit'
        && event.target === 'outreach/gmail' && event.requestId === start?.requestId));
    assert.ok(events.some(event => event.action === 'attachment.download' && event.target === null));
    assert.doesNotMatch(JSON.stringify(events), /abcdefghijklmnop|ari@example\.com|notes\.txt/u);
});
