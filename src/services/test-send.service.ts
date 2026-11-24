import type { Environment } from '../config/env.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel, type MessageStatus } from '../types/index.js';
import { normalizeEmail } from '../utils/email.util.js';
import { prepareRows } from './campaign.service.js';
import type { Store } from './message.service.js';
import { whatsappAccountId } from './whatsapp.service.js';

export type TestPhase = 'sending' | 'sent' | 'failed';

export interface TestState {
    account: string | null;
    confirmed: boolean;
    latest: { id: string; recipient: string; phase: TestPhase; error?: string; confirmed: boolean; current: boolean } | null;
}

const sentStatuses: readonly MessageStatus[] = ['SENT', 'DELIVERED', 'READ'];

export function senderAccountId(channel: CampaignChannel, env: Pick<Environment, 'GMAIL_USER'>, whatsappNumber?: string): string | null {
    if (channel === 'gmail') {
        try {
            return env.GMAIL_USER ? `gmail:${normalizeEmail(env.GMAIL_USER)}` : null;
        } catch {
            return null;
        }
    }
    const digits = whatsappNumber?.replaceAll(/\D/gu, '');
    return (digits && whatsappAccountId(`${digits}@s.whatsapp.net`)) ?? null;
}

export async function createTestCampaign(
    store: Store,
    env: Environment,
    channel: CampaignChannel,
    recipient: string,
): Promise<string> {
    const label = CAMPAIGN_CHANNEL_LABELS[channel];
    const id = `${channel}-test-${new Date().toISOString().replaceAll(/\D/gu, '').slice(0, 17)}`;
    const gmail = channel === 'gmail';
    const [row] = await prepareRows(store, env, id, [{
        rowNumber: 1,
        clientName: 'Test recipient',
        phone: gmail ? '' : recipient,
        ...(gmail ? { email: recipient, subject: 'Message Blaster test' } : {}),
        message: `This is a test from Message Blaster. If you can read this, ${label} sending works.`,
        pdfFilename: '',
        consentStatus: 'Opted In',
        campaignId: id,
    }], '', channel);
    if (!row || row.error) throw new Error(row?.error ?? 'Enter where to send the test.');
    store.importCampaign(id, [row], true, channel);
    return id;
}

export function testState(
    store: Store,
    channel: CampaignChannel,
    account: string | null,
    run: (id: string) => { active: boolean; error?: string },
): TestState {
    const campaign = store.latestTestCampaign(channel);
    const confirmed = account !== null && store.hasConfirmedTest(account);
    if (!campaign) return { account, confirmed, latest: null };
    const [message] = store.listMessages(campaign.id);
    const { active, error } = run(campaign.id);
    const sent = message !== undefined && sentStatuses.includes(message.status);
    const phase: TestPhase = active ? 'sending' : sent ? 'sent' : 'failed';
    const failure = phase === 'failed'
        ? error || message?.errorMessage || message?.error || `The test ${channel === 'gmail' ? 'email' : 'message'} was not sent.`
        : undefined;
    return {
        account,
        confirmed,
        latest: {
            id: campaign.id,
            recipient: (channel === 'gmail' ? message?.email : message?.phone) ?? '',
            phase,
            ...(failure ? { error: failure } : {}),
            confirmed: store.isConfirmedTestCampaign(campaign.id),
            current: campaign.accountId === null || campaign.accountId === account,
        },
    };
}
