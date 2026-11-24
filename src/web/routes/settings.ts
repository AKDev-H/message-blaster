import type { IncomingMessage } from 'node:http';
import { getCountries } from 'libphonenumber-js';
import type { AppSettings } from '../../config/env.js';
import { loadSettings, saveSettings } from '../../services/settings.service.js';
import { createTestCampaign, senderAccountId, testState } from '../../services/test-send.service.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../../types/index.js';
import { HttpError, orFail } from '../http-error.js';
import { json } from '../http.js';
import { readChannel, readGmailSettings, readJson, readSendingSettings, readTestRecipient } from '../input/index.js';
import type { App, Request, Route } from './route.js';

const TEST_PATH = /^\/api\/settings\/([a-z]+)\/test$/u;
const CONFIRM_PATH = /^\/api\/settings\/([a-z]+)\/test\/confirm$/u;

const answer = (step: (request: Request, app: App) => unknown) => async (request: Request, app: App) => {
    await step(request, app);
    json(request.res, 200, settingsView(app));
};

export const settingsRoutes: Route[] = [
    { method: 'GET', path: '/api/settings', handle: answer(() => undefined) },
    { method: 'PUT', path: '/api/settings/gmail', handle: answer(saveGmail) },
    { method: 'POST', path: '/api/settings/gmail/verify', handle: verifyGmail },
    { method: 'PUT', path: '/api/settings/sending', handle: answer(saveSending) },
    { method: 'POST', path: '/api/settings/whatsapp/link', handle: answer((_, app) => orFail(409, 'Could not link WhatsApp.', () => app.whatsapp.start())) },
    { method: 'DELETE', path: '/api/settings/whatsapp/link', handle: answer((_, app) => orFail(409, 'Could not link WhatsApp.', () => app.whatsapp.cancel())) },
    { method: 'POST', path: '/api/settings/whatsapp/unlink', handle: answer((_, app) => orFail(409, 'Could not unlink WhatsApp.', () => app.whatsapp.unlink())) },
    { method: 'POST', path: TEST_PATH, handle: answer(({ req, params }, app) => sendTest(app, readChannel(params[0]), req)) },
    { method: 'POST', path: CONFIRM_PATH, handle: answer(({ params }, app) => confirmTest(app, readChannel(params[0]))) },
];

function settingsView(app: App) {
    const { settings, unreadable } = loadSettings(app.env, app.db);
    const test = (channel: CampaignChannel) => testState(app.store, channel, senderAccount(app, channel, settings), id => app.runner.status(id));
    return {
        dryRun: app.env.DRY_RUN,
        gmail: {
            user: settings.GMAIL_USER,
            passwordSet: Boolean(settings.GMAIL_APP_PASSWORD),
            passwordUnreadable: unreadable.includes('GMAIL_APP_PASSWORD'),
            test: test('gmail'),
        },
        whatsapp: { ...app.whatsapp.state(), test: test('whatsapp') },
        sending: { country: settings.DEFAULT_COUNTRY, delaySeconds: settings.MESSAGE_DELAY_MS / 1_000 },
        countries: getCountries(),
    };
}

async function saveGmail({ req }: Request, app: App): Promise<void> {
    const body = await readJson(req);
    saveSettings(app.db, app.env, readGmailSettings(body, Boolean(app.settings().GMAIL_APP_PASSWORD)));
}

async function saveSending({ req }: Request, app: App): Promise<void> {
    saveSettings(app.db, app.env, readSendingSettings(await readJson(req)));
}

async function verifyGmail({ res }: Request, app: App): Promise<void> {
    const { GmailService } = await import('../../services/gmail.service.js');
    await orFail(502, 'Could not connect to Gmail.', () => new GmailService(app.settings()).connect());
    json(res, 200, { ok: true });
}

function senderAccount(app: App, channel: CampaignChannel, settings: AppSettings): string | null {
    if (channel === 'gmail') return settings.GMAIL_APP_PASSWORD ? senderAccountId('gmail', settings) : null;
    const link = app.whatsapp.state();
    return link.status === 'linked' ? senderAccountId('whatsapp', settings, link.account) : null;
}

async function sendTest(app: App, channel: CampaignChannel, req: IncomingMessage): Promise<void> {
    const recipient = readTestRecipient(await readJson(req), channel);
    if (app.env.DRY_RUN) throw new HttpError(409, 'Live sending is off. Set DRY_RUN=false in .env, then restart the dashboard.');
    const settings = app.settings();
    if (!senderAccount(app, channel, settings)) throw new HttpError(409, channel === 'gmail' ? 'Save your Gmail address and App Password first.' : 'Link WhatsApp first.');
    app.runner.ensureIdle();
    const id = await orFail(400, 'Check the test recipient.', () => createTestCampaign(app.store, settings, channel, recipient), 'testRecipient');
    startTest(app, id);
}

function startTest(app: App, id: string): void {
    try {
        app.runner.launch(id, 'start', id);
    } catch (error) {
        app.store.deleteCampaign(id);
        throw error;
    }
    app.updates.changed();
}

async function confirmTest(app: App, channel: CampaignChannel): Promise<void> {
    const account = senderAccount(app, channel, app.settings());
    const latest = testState(app.store, channel, account, id => app.runner.status(id)).latest;
    if (!account || !latest) throw new HttpError(409, `Send a ${CAMPAIGN_CHANNEL_LABELS[channel]} test first.`);
    if (latest.phase !== 'sent') throw new HttpError(409, 'Only a test that was sent can be confirmed.');
    await orFail(409, 'The test could not be confirmed.', () => app.store.confirmTest(latest.id, account));
}
