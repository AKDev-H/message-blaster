import type { Environment } from '../config/env.js';
import { senderAccountId } from '../services/test-send.service.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../types/index.js';
import type { App } from './routes/route.js';

type SenderSettings = Pick<Environment, 'GMAIL_USER' | 'GMAIL_APP_PASSWORD'>;

export function senderAccount(app: App, channel: CampaignChannel, settings: SenderSettings): string | null {
    if (channel === 'gmail') return settings.GMAIL_APP_PASSWORD ? senderAccountId('gmail', settings) : null;
    const link = app.whatsapp.state();
    return link.status === 'linked' ? senderAccountId('whatsapp', settings, link.account) : null;
}

export function senderProblem(app: App, channel: CampaignChannel, settings: SenderSettings): string | undefined {
    const label = CAMPAIGN_CHANNEL_LABELS[channel];
    const account = senderAccount(app, channel, settings);
    if (!account) return channel === 'gmail' ? 'Save your Gmail address and App Password in Settings first.' : 'Link WhatsApp in Settings first.';
    if (!app.store.hasConfirmedTest(account)) return `Send and confirm a ${label} test in Settings › ${label} first.`;
    return undefined;
}
