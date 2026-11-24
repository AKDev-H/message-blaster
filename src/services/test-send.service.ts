import type { Environment } from '../config/env.js';
import type { Campaign, MessageRecord, Store } from '../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel, type MessageStatus } from '../types/index.js';
import { normalizeEmail } from '../utils/email.util.js';
import type { ImportRow } from './excel/columns.js';
import { prepareRows } from './campaign/prepare-rows.js';
import { whatsappAccountId } from './whatsapp/account.js';

export type TestPhase = 'sending' | 'sent' | 'failed';

export interface LatestTest {
    id: string;
    recipient: string;
    phase: TestPhase;
    error?: string;
    confirmed: boolean;
    current: boolean;
}

export interface TestState {
    account: string | null;
    confirmed: boolean;
    latest: LatestTest | null;
}

type RunStatus = (id: string) => { active: boolean; error?: string };

const SENT_STATUSES: readonly MessageStatus[] = ['SENT', 'DELIVERED', 'READ'];

export function senderAccountId(channel: CampaignChannel, env: Pick<Environment, 'GMAIL_USER'>, whatsappNumber?: string): string | null {
    if (channel === 'gmail') return gmailAccountId(env.GMAIL_USER);
    const digits = whatsappNumber?.replaceAll(/\D/gu, '');
    return (digits && whatsappAccountId(`${digits}@s.whatsapp.net`)) ?? null;
}

export async function createTestCampaign(store: Store, env: Environment, channel: CampaignChannel, recipient: string): Promise<string> {
    const id = `${channel}-test-${new Date().toISOString().replaceAll(/\D/gu, '').slice(0, 17)}`;
    const [row] = await prepareRows(store, env, id, [testRow(id, channel, recipient)], '', channel);
    if (!row || row.error) throw new Error(row?.error ?? 'Enter where to send the test.');
    store.importCampaign(id, [row], true, channel);
    return id;
}

export function testState(store: Store, channel: CampaignChannel, account: string | null, run: RunStatus): TestState {
    const campaign = store.latestTestCampaign(channel);
    const confirmed = account !== null && store.hasConfirmedTest(account);
    return { account, confirmed, latest: campaign ? latestTest(store, campaign, account, run) : null };
}

function gmailAccountId(user: string): string | null {
    try {
        return user ? `gmail:${normalizeEmail(user)}` : null;
    } catch {
        return null;
    }
}

function testRow(id: string, channel: CampaignChannel, recipient: string): ImportRow {
    const gmail = channel === 'gmail';
    return {
        rowNumber: 1,
        clientName: 'Test recipient',
        phone: gmail ? '' : recipient,
        ...(gmail ? { email: recipient, subject: 'Message Blaster test' } : {}),
        message: `This is a test from Message Blaster. If you can read this, ${CAMPAIGN_CHANNEL_LABELS[channel]} sending works.`,
        pdfFilename: '',
        consentStatus: 'Opted In',
        campaignId: id,
    };
}

function latestTest(store: Store, campaign: Campaign, account: string | null, run: RunStatus): LatestTest {
    const [message] = store.listMessages(campaign.id);
    const { active, error } = run(campaign.id);
    const phase = testPhase(active, message);
    const failure = phase === 'failed' ? failureReason(campaign.channel, error, message) : undefined;
    return {
        id: campaign.id,
        recipient: (campaign.channel === 'gmail' ? message?.email : message?.phone) ?? '',
        phase,
        ...(failure ? { error: failure } : {}),
        confirmed: store.isConfirmedTestCampaign(campaign.id),
        current: campaign.accountId === null || campaign.accountId === account,
    };
}

function testPhase(active: boolean, message: MessageRecord | undefined): TestPhase {
    if (active) return 'sending';
    return message !== undefined && SENT_STATUSES.includes(message.status) ? 'sent' : 'failed';
}

function failureReason(channel: CampaignChannel, runError: string | undefined, message: MessageRecord | undefined): string {
    const fallback = `The test ${channel === 'gmail' ? 'email' : 'message'} was not sent.`;
    return runError || message?.errorMessage || message?.error || fallback;
}
