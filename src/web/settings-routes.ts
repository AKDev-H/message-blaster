import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { getCountries } from 'libphonenumber-js';
import type { AppSettings, BaseEnvironment } from '../config/env.js';
import type { Store } from '../services/message.service.js';
import { loadSettings, saveSettings } from '../services/settings.service.js';
import { createTestCampaign, senderAccountId, testState } from '../services/test-send.service.js';
import type { WhatsAppLinker } from '../services/whatsapp-link.service.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../types/index.js';
import { HttpError, readChannel, readGmailSettings, readJson, readSendingSettings, readTestRecipient } from './input.js';
import type { WebRunner } from './runner.js';

interface SettingsContext {
    env: BaseEnvironment;
    db: DatabaseSync;
    store: Store;
    runner: WebRunner;
    whatsapp: WhatsAppLinker;
    changed(): void;
}

const conflict = (error: unknown, fallback: string) => new HttpError(409, error instanceof Error ? error.message : fallback);

export function createSettingsRoutes({ env, db, store, runner, whatsapp, changed }: SettingsContext) {
    const current = () => ({ ...env, ...loadSettings(env, db).settings });

    function senderAccount(channel: CampaignChannel, settings: AppSettings): string | null {
        if (channel === 'gmail') return settings.GMAIL_APP_PASSWORD ? senderAccountId('gmail', settings) : null;
        const link = whatsapp.state();
        return link.status === 'linked' ? senderAccountId('whatsapp', settings, link.account) : null;
    }

    const runStatus = (id: string) => runner.status(id);

    function view() {
        const { settings, unreadable } = loadSettings(env, db);
        const test = (channel: CampaignChannel) => testState(store, channel, senderAccount(channel, settings), runStatus);
        return {
            dryRun: env.DRY_RUN,
            gmail: {
                user: settings.GMAIL_USER,
                passwordSet: Boolean(settings.GMAIL_APP_PASSWORD),
                passwordUnreadable: unreadable.includes('GMAIL_APP_PASSWORD'),
                test: test('gmail'),
            },
            whatsapp: { ...whatsapp.state(), test: test('whatsapp') },
            sending: { country: settings.DEFAULT_COUNTRY, delaySeconds: settings.MESSAGE_DELAY_MS / 1_000 },
            countries: getCountries(),
        };
    }

    async function sendTest(channel: CampaignChannel, req: IncomingMessage) {
        const recipient = readTestRecipient(await readJson(req), channel);
        if (env.DRY_RUN) throw new HttpError(409, 'Live sending is off. Set DRY_RUN=false in .env, then restart the dashboard.');
        const settings = current();
        if (!senderAccount(channel, settings)) {
            throw new HttpError(409, channel === 'gmail' ? 'Save your Gmail address and App Password first.' : 'Link WhatsApp first.');
        }
        runner.ensureIdle();
        let id: string;
        try {
            id = await createTestCampaign(store, settings, channel, recipient);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : 'Check the test recipient.', 'testRecipient');
        }
        try {
            runner.launch(id, 'start', id);
        } catch (error) {
            store.deleteCampaign(id);
            throw error;
        }
        changed();
    }

    function confirmTest(channel: CampaignChannel) {
        const account = senderAccount(channel, current());
        const latest = testState(store, channel, account, runStatus).latest;
        if (!account || !latest) throw new HttpError(409, `Send a ${CAMPAIGN_CHANNEL_LABELS[channel]} test first.`);
        if (latest.phase !== 'sent') throw new HttpError(409, 'Only a test that was sent can be confirmed.');
        try {
            store.confirmTest(latest.id, account);
        } catch (error) {
            throw conflict(error, 'The test could not be confirmed.');
        }
    }

    async function handle(pathname: string, method: string | undefined, req: IncomingMessage): Promise<unknown> {
        if (!pathname.startsWith('/api/settings')) return undefined;
        if (pathname === '/api/settings' && method === 'GET') return view();
        if (pathname === '/api/settings/gmail' && method === 'PUT') {
            saveSettings(db, env, readGmailSettings(await readJson(req), Boolean(current().GMAIL_APP_PASSWORD)));
            return view();
        }
        if (pathname === '/api/settings/gmail/verify' && method === 'POST') {
            const { GmailService } = await import('../services/gmail.service.js');
            try {
                await new GmailService(current()).connect();
            } catch (error) {
                throw new HttpError(502, error instanceof Error ? error.message : 'Could not connect to Gmail.');
            }
            return { ok: true };
        }
        if (pathname === '/api/settings/sending' && method === 'PUT') {
            saveSettings(db, env, readSendingSettings(await readJson(req)));
            return view();
        }
        if (pathname === '/api/settings/whatsapp/link' && (method === 'POST' || method === 'DELETE')) {
            try {
                await (method === 'POST' ? whatsapp.start() : whatsapp.cancel());
            } catch (error) {
                throw conflict(error, 'Could not link WhatsApp.');
            }
            return view();
        }
        if (pathname === '/api/settings/whatsapp/unlink' && method === 'POST') {
            try {
                await whatsapp.unlink();
            } catch (error) {
                throw conflict(error, 'Could not unlink WhatsApp.');
            }
            return view();
        }
        const test = /^\/api\/settings\/([a-z]+)\/test(\/confirm)?$/u.exec(pathname);
        if (test?.[1] && method === 'POST') {
            const channel = readChannel(test[1]);
            await (test[2] ? confirmTest(channel) : sendTest(channel, req));
            return view();
        }
        return undefined;
    }

    return { handle };
}
