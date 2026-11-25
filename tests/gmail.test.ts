import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { DEFAULT_SETTINGS, loadEnv } from '../src/config/env.js';
import { openDatabase } from '../src/database/connection.js';
import { initialMigration } from '../src/database/migrations/001-initial.js';
import { exportCampaign } from '../src/services/campaign/export.js';
import { importCampaign } from '../src/services/campaign/import.js';
import { generateExcel } from '../src/services/excel/template.js';
import { EmailService } from '../src/services/email.service.js';
import { runLiveCampaign } from '../src/services/live-campaign.service.js';
import { Store } from '../src/store/index.js';

test('Gmail import and approved SMTP runs share the campaign queue and track acceptance', async context => {
    const dir = await mkdtemp(join(tmpdir(), 'gmail-campaign-'));
    context.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'clients.xlsx');
    assert.equal(await generateExcel(path, 'gmail'), true);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.worksheets[0]!;
    sheet.getRow(2).values = [
        'Example Client', { text: 'Client@example.com', hyperlink: 'mailto:Client@example.com' },
        'Document for {{client_name}}', 'Hello {{email_address}}', 'sample-document.pdf', 'Opted In', 'campaign',
    ];
    sheet.addRow(['Opt Out', 'out@example.com', 'A subject', 'Body', '', 'Opted In', 'campaign']);
    sheet.addRow(['Duplicate A', 'dup@example.com', 'A subject', 'Body', '', 'Opted In', 'campaign']);
    sheet.addRow(['Duplicate B', 'DUP@example.com', 'A subject', 'Body', '', 'Opted In', 'campaign']);
    await workbook.xlsx.writeFile(path);

    const env = {
        ...loadEnv(),
        ...DEFAULT_SETTINGS,
        DATABASE_URL: join(dir, 'test.db'),
        LOG_DIR: dir,
        ATTACHMENTS_DIR: 'tests/fixtures',
        MESSAGE_DELAY_MS: 0,
        DRY_RUN: false,
        GMAIL_USER: 'Sender@example.com',
        GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
    };
    using db = openDatabase(env.DATABASE_URL);
    const store = new Store(db);
    const campaign = await importCampaign(store, env, 'campaign', { source: path, channel: 'gmail' });
    assert.equal(campaign.channel, 'gmail');
    assert.equal(store.withdraw('out@example.com', 'gmail'), 1);
    assert.deepEqual(store.listMessages('campaign').map(record => record.status), ['PENDING', 'SKIPPED', 'SKIPPED', 'SKIPPED']);

    const sent: SendMailOptions[] = [];
    let verifications = 0;
    const smtp = context.mock.method(nodemailer, 'createTransport', () => ({
        async verify() {
            verifications += 1;
            return true;
        },
        async sendMail(message: SendMailOptions) {
            sent.push(message);
            return { accepted: [message.to] };
        },
    }));
    const run = (id: string) => runLiveCampaign(store, env, id, 'start', { live: true, approve: id }, () => {});
    await assert.rejects(run('campaign'), /gmail:confirm-test/);
    assert.equal(verifications, 0);
    assert.equal(sent.length, 0);

    const [recipient] = store.listMessages('campaign');
    assert.ok(recipient);
    store.importCampaign('test-mail', [recipient], true, 'gmail');
    await run('test-mail');
    store.confirmTest('test-mail');
    assert.equal((await run('campaign'))?.attempts, 1);

    assert.equal(verifications, 2);
    const [options] = smtp.mock.calls[0]!.arguments;
    assert.deepEqual(options, {
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: 'sender@example.com', pass: 'abcdefghijklmnop' },
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
        disableFileAccess: true, disableUrlAccess: true,
    });
    assert.equal(sent.length, 2);
    const mail = sent[1]!;
    const result = store.listMessages('campaign')[0]!;
    assert.equal(mail.to, 'client@example.com');
    assert.equal(mail.subject, 'Document for Example Client');
    assert.equal(mail.text, 'Hello client@example.com');
    assert.equal(mail.attachments?.[0]?.filename, 'sample-document.pdf');
    assert.ok(Buffer.isBuffer(mail.attachments?.[0]?.content));
    assert.match(mail.messageId ?? '', /^<[a-f0-9-]+@example\.com>$/);
    assert.equal(result.transportMessageId, mail.messageId);
    assert.equal(result.status, 'SENT');
    assert.ok(result.acknowledgedAt);
    assert.equal(result.deliveredAt, null);

    const exportPath = join(dir, 'results.xlsx');
    await exportCampaign(store, 'campaign', exportPath);
    await workbook.xlsx.readFile(exportPath);
    const results = workbook.worksheets[0]!;
    assert.equal(results.getCell('B1').value, 'Email Address');
    assert.equal(results.getCell('I1').value, 'Gmail Message ID');
    assert.equal(results.getCell('I2').value, mail.messageId);
});

test('custom SMTP connects with the saved server, security mode and From name', async context => {
    const sent: SendMailOptions[] = [];
    const smtp = context.mock.method(nodemailer, 'createTransport', () => ({
        verify: async () => true,
        async sendMail(message: SendMailOptions) {
            sent.push(message);
            return { accepted: [message.to] };
        },
    }));
    const settings = {
        ...DEFAULT_SETTINGS, EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: 587, SMTP_SECURITY: 'starttls',
        SMTP_USER: 'apikey', SMTP_PASSWORD: 'secret', SMTP_FROM: 'Team@Example.com', SMTP_FROM_NAME: 'Team',
    } as const;
    const service = new EmailService(settings);
    assert.equal(service.accountId, 'smtp:smtp.example.com:team@example.com');
    await service.connect();
    await service.send({ id: '<id@example.com>', phone: '', email: 'client@example.com', subject: 'Hi', text: 'Hello' });
    assert.deepEqual(smtp.mock.calls[0]!.arguments[0], {
        host: 'smtp.example.com', port: 587, secure: false, requireTLS: true,
        auth: { user: 'apikey', pass: 'secret' },
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
        disableFileAccess: true, disableUrlAccess: true,
    });
    assert.deepEqual(sent[0]?.from, { name: 'Team', address: 'team@example.com' });

    new EmailService({ ...settings, SMTP_SECURITY: 'tls', SMTP_PORT: 465, SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM_NAME: '' });
    assert.deepEqual(smtp.mock.calls[1]!.arguments[0], {
        host: 'smtp.example.com', port: 465, secure: true,
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
        disableFileAccess: true, disableUrlAccess: true,
    }, 'servers without sign-in get no auth block');
    assert.throws(() => new EmailService({ ...settings, SMTP_PASSWORD: '' }), /SMTP password/);
});

test('the Gmail migration preserves legacy WhatsApp campaigns, attempts and withdrawals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-campaign-'));
    const path = join(dir, 'legacy.db');
    try {
        {
            using legacy = new DatabaseSync(path);
            legacy.exec(initialMigration);
            legacy.exec(`
        PRAGMA user_version = 1;
        INSERT INTO campaigns VALUES ('old', 'Completed', 'linked-account', 1, 'yesterday', 'today');
        INSERT INTO messages (
          id, campaign_id, row_number, client_id, client_name, phone, message, pdf_filename,
          consent_status, eligible, status, whatsapp_message_id, sent_at, attempt_count
        ) VALUES (1, 'old', 2, 'C1', 'Example', '+12025550123', 'Body', '', 'Opted In', 1, 'SENT', 'original-id', 'today', 1);
        INSERT INTO message_attempts VALUES (1, 1, 'original-id', 'SENT', 'today', 'today', NULL);
        INSERT INTO consent_withdrawals VALUES ('+12025550123', 'today');
        INSERT INTO confirmed_test VALUES ('linked-account', 'old', 'today');
      `);
        }

        using upgraded = openDatabase(path);
        const store = new Store(upgraded);
        assert.equal(store.getCampaign('old').channel, 'whatsapp');
        assert.equal(store.listMessages('old')[0]?.phone, '+12025550123');
        assert.equal(store.listAttempts('old')[0]?.transportMessageId, 'original-id');
        assert.equal(store.hasConfirmedTest('linked-account'), true);
        assert.equal(store.isWithdrawn('+12025550123'), true);
        store.receipt('original-id', 'DELIVERED');
        assert.equal(store.listMessages('old')[0]?.status, 'DELIVERED');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
