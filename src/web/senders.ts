import { EMAIL_SETUP_HINT, isEmailConfigured, type EmailSettings } from '../services/email-account.js';
import { senderAccountId } from '../services/test-send.service.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../types/index.js';
import type { App } from './routes/route.js';

export function senderAccount(app: App, channel: CampaignChannel, settings: EmailSettings): string | null {
    if (channel === 'gmail') return isEmailConfigured(settings) ? senderAccountId('gmail', settings) : null;
    const link = app.whatsapp.state();
    return link.status === 'linked' ? senderAccountId('whatsapp', settings, link.account) : null;
}

export function senderProblem(app: App, channel: CampaignChannel, settings: EmailSettings): string | undefined {
    const label = CAMPAIGN_CHANNEL_LABELS[channel];
    const account = senderAccount(app, channel, settings);
    if (!account) return channel === 'gmail' ? `${EMAIL_SETUP_HINT[settings.EMAIL_PROVIDER]} in Settings › Email first.` : 'Link WhatsApp in Settings first.';
    if (!app.store.hasConfirmedTest(account)) return `Send and confirm a ${label} test in Settings › ${channel === 'gmail' ? 'Email' : label} first.`;
    return undefined;
}
