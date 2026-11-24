import type { Command } from 'commander';
import type { Environment } from '../../config/env.js';
import { prepareRows } from '../../services/campaign/prepare-rows.js';
import { validateDeliveryApproval, type DeliveryOptions } from '../../services/live-campaign.service.js';
import type { Store } from '../../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../../types/index.js';
import { withDb } from '../context.js';
import { operate } from '../operate.js';
import { campaignId, liveCommand } from '../options.js';

type TestOptions = DeliveryOptions & {
    phone?: string;
    email?: string;
    subject?: string;
    consent?: boolean;
    message?: string;
    pdf?: string;
};

export function registerTestCommands(program: Command): void {
    for (const channel of ['whatsapp', 'gmail'] as const) {
        registerSendTest(program, channel);
        registerConfirmTest(program, channel);
    }
}

function registerSendTest(program: Command, channel: CampaignChannel): void {
    const label = CAMPAIGN_CHANNEL_LABELS[channel];
    const command = liveCommand(program.command(`${channel}:test`).description(`Prepare or send one opted-in ${label} test`))
        .option('--consent', 'Confirm the test recipient explicitly opted in')
        .option('--message <text>', 'Test message', `This is an approved ${label} campaign test.`)
        .option('--pdf <filename>', 'PDF filename in the attachments directory');
    if (channel === 'gmail') command.option('--email <address>', 'Email address to prepare').option('--subject <text>', 'Test subject', 'Message Blaster Gmail test');
    else command.option('--phone <number>', 'Phone number to prepare');
    command.action((id: string, options: TestOptions) => withDb((store, env) => sendTest(store, env, id, channel, options)));
}

function registerConfirmTest(program: Command, channel: CampaignChannel): void {
    program.command(`${channel}:confirm-test`).description(`Record confirmed receipt of the single ${CAMPAIGN_CHANNEL_LABELS[channel]} test`)
        .argument('<id>', 'Test campaign ID', campaignId)
        .requiredOption('--received', 'Confirm independently that the recipient received the test')
        .action((id: string) => withDb(store => {
            verifyTestChannel(store, id, channel);
            store.confirmTest(id);
            console.log(`Confirmed test ${id} for its sender account.`);
        }));
}

async function sendTest(store: Store, env: Environment, id: string, channel: CampaignChannel, options: TestOptions): Promise<void> {
    validateDeliveryApproval(env, id, options);
    if (options.email !== undefined || options.phone !== undefined) await createTest(store, env, id, channel, options);
    verifyTestChannel(store, id, channel);
    await operate(store, env, id, 'start', options);
}

async function createTest(store: Store, env: Environment, id: string, channel: CampaignChannel, options: TestOptions): Promise<void> {
    if (!options.consent) throw new Error('Test preparation requires --consent.');
    const rows = await prepareRows(store, env, id, [testContact(id, channel, options)], '', channel);
    const row = rows[0];
    if (!row || row.error) throw new Error(row?.error ?? 'Test contact is required.');
    store.importCampaign(id, rows, true, channel);
}

function testContact(id: string, channel: CampaignChannel, options: TestOptions) {
    return {
        rowNumber: 1,
        clientName: 'Test Contact',
        phone: options.phone ?? '',
        ...(channel === 'gmail' ? { email: options.email ?? '', subject: options.subject ?? '' } : {}),
        message: options.message ?? '',
        pdfFilename: options.pdf ?? '',
        consentStatus: 'Opted In',
        campaignId: id,
    };
}

function verifyTestChannel(store: Store, id: string, channel: CampaignChannel): void {
    const campaign = store.getCampaign(id);
    if (!campaign.isTest || campaign.channel !== channel) throw new Error(`Use the ID of a dedicated ${channel} test campaign.`);
}
