import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { CAMPAIGN_ID } from './config/constants.js';
import { loadEnv, type BaseEnvironment, type Environment } from './config/env.js';
import { openDatabase, backupDatabase } from './database/connection.js';
import { exportCampaign, importCampaign, prepareRows, summarizeRecipients } from './services/campaign.service.js';
import { generateExcel } from './services/excel.service.js';
import { Store } from './services/message.service.js';
import { migrateSettings, withSavedSettings } from './services/settings.service.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from './types/index.js';
import { normalizeEmail } from './utils/email.util.js';
import { normalizePhone } from './utils/phone.util.js';
import {
    recoverInterruptedCampaigns, runLiveCampaign, validateDeliveryApproval, wait, withWhatsAppSession,
    type DeliveryOptions, type RunMode,
} from './services/live-campaign.service.js';

function campaignId(value: string) {
    if (!CAMPAIGN_ID.test(value)) throw new InvalidArgumentError('Use 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.');
    return value;
}

function integer(value: string) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Use a non-negative integer.');
    return Number(value);
}

type TestOptions = DeliveryOptions & {
    phone?: string;
    email?: string;
    subject?: string;
    consent?: boolean;
    message?: string;
    pdf?: string;
};

function channelOption() {
    return new Option('--channel <channel>', 'Campaign channel').choices(['whatsapp', 'gmail']).default('whatsapp');
}

function workbookPath(env: Pick<BaseEnvironment, 'EXCEL_FILE' | 'GMAIL_EXCEL_FILE'>, channel: CampaignChannel) {
    return channel === 'gmail' ? env.GMAIL_EXCEL_FILE : env.EXCEL_FILE;
}

export async function runCli(argv: string[]) {
    const program = new Command()
        .name('message-blaster')
        .description('Prepare and operate opted-in WhatsApp and Gmail campaigns.')
        .showHelpAfterError()
        .exitOverride();
    program.command('setup').description('Initialize local directories, database and sample workbook')
        .action(() => withDb(async (_store, env) => {
            await Promise.all([env.AUTH_DIR, env.LOG_DIR, env.ATTACHMENTS_DIR].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
            const created = await generateExcel(env.EXCEL_FILE);
            console.log(created ? `Created sample workbook ${env.EXCEL_FILE}` : `Using existing workbook ${env.EXCEL_FILE}`);
            console.log(`Database ready at ${env.DATABASE_URL}`);
        }));

    program.command('excel:generate').description('Create a blank-ready template with an ineligible example row')
        .addOption(channelOption())
        .option('--file <path>', 'Workbook path').action(async ({ file, channel }: { file?: string; channel: CampaignChannel }) => {
        const path = file ?? workbookPath(loadEnv(), channel);
        console.log(await generateExcel(path, channel) ? `Created ${path}` : `Workbook already exists at ${path}`);
    });

    program.command('whatsapp:connect').description('Link WhatsApp Business through a terminal QR code')
        .option('--listen', 'Keep the connection open for receipt updates').action(({ listen }: { listen?: boolean }) =>
        withDb((store, env) => withWhatsAppSession(store, env, true, async ({ socket, signal }) => {
            console.log('WhatsApp connected.');
            if (!listen) return;

            console.log('Listening for receipts. Press Ctrl+C to close.');
            while (!signal.aborted) {
                await wait(1_000, signal);
                if (!signal.aborted && !socket.isReady) await socket.waitUntilReady(signal);
            }
        })));

    program.command('campaign:import').description('Validate and snapshot workbook rows into a new campaign')
        .argument('<id>', 'Campaign ID', campaignId)
        .addOption(channelOption())
        .option('--file <path>', 'Import workbook')
        .option('--template <path>', 'Fallback message template in a local UTF-8 file')
        .action((id: string, options: { file?: string; template?: string; channel: CampaignChannel }) => withDb(async (store, env) => {
            const source = options.file ?? workbookPath(env, options.channel);
            if (!options.file) await generateExcel(source, options.channel);
            const campaign = await importCampaign(store, env, id, {
                source,
                channel: options.channel,
                ...(options.template ? { templatePath: options.template } : {}),
            });
            console.log(`Campaign ${id} (${campaign.channel}) is ${campaign.state}.`);
            console.table([summarizeRecipients(store.listMessages(id), campaign.channel)]);
        }));

    program.command('campaign:preview').description('Show the saved recipients, messages and validation results')
        .argument('<id>', 'Campaign ID', campaignId)
        .option('--limit <count>', 'Rows to display', integer, 20)
        .action((id: string, { limit }: { limit: number }) => withDb(store => preview(store, id, limit)));

    program.command('campaign:status').description('Show campaign progress and available receipt totals')
        .argument('<id>', 'Campaign ID', campaignId)
        .option('--attempts', 'Show the durable attempt history')
        .action((id: string, { attempts }: { attempts?: boolean }) => withDb(store => {
            printStatus(store, id);
            if (attempts) console.table(store.listAttempts(id));
        }));

    program.command('campaign:recover').description('Reconcile interrupted campaigns before manual review')
        .action(() => withDb(async (store, env) => {
            const recovered = await recoverInterruptedCampaigns(store, env.DATABASE_URL);
            console.log(`Recovered campaign state. ${recovered} interrupted messages now require manual review.`);
        }));

    const controls = ['pause', 'cancel'] as const;
    for (const control of controls) {
        program.command(`campaign:${control}`).description(`${control === 'pause' ? 'Pause' : 'Cancel'} a campaign`)
            .argument('<id>', 'Campaign ID', campaignId).action((id: string) => withDb(store => {
            store[control](id);
            printStatus(store, id);
        }));
    }

    for (const mode of ['start', 'resume'] as const) {
        liveCommand(program.command(`campaign:${mode}`).description(`${mode === 'start' ? 'Start' : 'Resume'} an approved campaign`))
            .action((id: string, options: DeliveryOptions) => withDb((store, env) => {
                const campaign = store.getCampaign(id);
                if (mode === 'start' && campaign.isTest) throw new Error(`Start test campaigns with ${campaign.channel}:test.`);
                return operate(store, env, id, mode, options);
            }));
    }

    for (const channel of ['whatsapp', 'gmail'] as const) {
        const gmail = channel === 'gmail';
        const label = CAMPAIGN_CHANNEL_LABELS[channel];
        const command = liveCommand(program.command(`${channel}:test`).description(`Prepare or send one opted-in ${label} test`))
            .option('--consent', 'Confirm the test recipient explicitly opted in')
            .option('--message <text>', 'Test message', `This is an approved ${label} campaign test.`)
            .option('--pdf <filename>', 'PDF filename in the attachments directory');
        if (gmail) {
            command.option('--email <address>', 'Email address to prepare')
                .option('--subject <text>', 'Test subject', 'Message Blaster Gmail test');
        } else {
            command.option('--phone <number>', 'Phone number to prepare');
        }
        command.action((id: string, options: TestOptions) => withDb(async (store, env) => {
            validateDeliveryApproval(env, id, options);
            if (options.email !== undefined || options.phone !== undefined) {
                if (!options.consent) throw new Error('Test preparation requires --consent.');
                const rows = await prepareRows(store, env, id, [{
                    rowNumber: 1,
                    clientName: 'Test Contact',
                    phone: options.phone ?? '',
                    ...(gmail ? { email: options.email ?? '', subject: options.subject ?? '' } : {}),
                    message: options.message ?? '',
                    pdfFilename: options.pdf ?? '',
                    consentStatus: 'Opted In',
                    campaignId: id,
                }], '', channel);
                const row = rows[0];
                if (!row || row.error) throw new Error(row?.error ?? 'Test contact is required.');
                store.importCampaign(id, rows, true, channel);
            }
            verifyTestChannel(store, id, channel);
            await operate(store, env, id, 'start', options);
        }));

        program.command(`${channel}:confirm-test`).description(`Record confirmed receipt of the single ${label} test`)
            .argument('<id>', 'Test campaign ID', campaignId)
            .requiredOption('--received', 'Confirm independently that the recipient received the test')
            .action((id: string) => withDb(store => {
                verifyTestChannel(store, id, channel);
                store.confirmTest(id);
                console.log(`Confirmed test ${id} for its sender account.`);
            }));
    }

    program.command('consent:withdraw').description('Block a recipient from future submissions and skip queued messages')
        .argument('<recipient>', 'Recipient phone number or email address')
        .addOption(channelOption())
        .action((recipient: string, { channel }: { channel: CampaignChannel }) => withDb((store, env) => {
            const address = channel === 'gmail' ? normalizeEmail(recipient) : normalizePhone(recipient, env.DEFAULT_COUNTRY);
            const count = store.withdraw(address, channel);
            console.log(`Recorded withdrawal. Skipped ${count} queued messages.`);
        }));

    program.command('campaign:review').description('Record the verified outcome of a message under manual review')
        .argument('<record>', 'Record ID from campaign preview', integer)
        .requiredOption('--outcome <status>', 'Verified SENT or FAILED')
        .requiredOption('--note <text>', 'Reason and evidence for the decision')
        .action((record: number, { outcome, note }: { outcome: string; note: string }) => withDb(store => {
            if ((outcome !== 'SENT' && outcome !== 'FAILED') || !note.trim() || note.length > 1_000) {
                throw new Error('Provide SENT or FAILED and a review note of up to 1,000 characters.');
            }
            store.review(record, outcome, note.trim());
            console.log(`Recorded manual review of message ${record}.`);
        }));

    program.command('campaign:export').description('Export the campaign snapshot and results to a new workbook')
        .argument('<id>', 'Campaign ID', campaignId)
        .option('--output <path>', 'Output workbook path').action((id: string, { output }: { output?: string }) => withDb(async store => {
        const path = output ?? join('storage', `${id}-results.xlsx`);
        await exportCampaign(store, id, path);
        console.log(`Exported ${id} to ${path}`);
    }));

    program.command('db:backup').description('Create a consistent SQLite backup at a new destination')
        .argument('<path>', 'Backup destination').action((path: string) => withDb(async (_store, _env, db) => {
        await backupDatabase(db, path);
        console.log(`Backup saved to ${path}`);
    }));

    try {
        await program.parseAsync(argv);
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        process.exitCode = error.exitCode;
    }
}

function verifyTestChannel(store: Store, id: string, channel: CampaignChannel) {
    const campaign = store.getCampaign(id);
    if (!campaign.isTest || campaign.channel !== channel) {
        throw new Error(`Use the ID of a dedicated ${channel} test campaign.`);
    }
}

function liveCommand(command: Command) {
    return command.argument('<id>', 'Campaign ID', campaignId)
        .option('--live', 'Use live delivery for the campaign channel')
        .option('--approve <id>', 'Explicitly approve the named campaign for this run', campaignId);
}

async function withDb(action: (store: Store, env: Environment, db: DatabaseSync) => void | Promise<void>) {
    const base = loadEnv();
    using db = openDatabase(base.DATABASE_URL);
    migrateSettings(db, base);
    await action(new Store(db), withSavedSettings(base, db), db);
}

async function operate(store: Store, env: Environment, id: string, mode: RunMode, options: DeliveryOptions) {
    if (!options.live) {
        console.log('Dry run. Previewing the saved campaign.');
        preview(store, id, 20);
        return;
    }

    const result = await runLiveCampaign(store, env, id, mode, options, recovered => {
        console.log(`${recovered} interrupted messages now require manual review.`);
    });
    if (!result) return;
    console.log(`Processed ${result.attempts} attempts during this run.`);
    printStatus(store, id);
    if (result.connectionError) throw result.connectionError;
}

function preview(store: Store, id: string, limit: number) {
    const campaign = store.getCampaign(id);
    const rows = store.listMessages(id);
    console.log(`Campaign ${id} (${campaign.channel}) is ${campaign.state}. Showing up to ${limit} recipient records.`);
    console.table([summarizeRecipients(rows, campaign.channel)]);
    for (const row of rows.slice(0, limit)) {
        console.log(terminalText(`\n#${row.id} • Excel row ${row.rowNumber} • ${row.clientName} • ${row.email ?? row.phone}`));
        console.log(terminalText(`${row.status} • Consent ${row.consentStatus || 'missing'}`));
        if (row.errorMessage) console.log(terminalText(row.errorMessage));
        if (row.pdfFilename) console.log(terminalText(`PDF ${row.pdfFilename}`));
        if (row.subject) console.log(terminalText(`Subject ${row.subject}`));
        if (row.message) console.log(terminalText(row.message));
    }
}

function terminalText(text: string) {
    // eslint-disable-next-line no-control-regex -- Strip control characters before writing untrusted text to the terminal.
    return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
}

function printStatus(store: Store, id: string) {
    const campaign = store.getCampaign(id);
    const rows = store.listMessages(id);
    console.log(`Campaign ${id} (${campaign.channel}) is ${campaign.state}.`);
    console.table([summarizeRecipients(rows, campaign.channel)]);
    console.table([store.progress(id)]);
    console.table([{
        submitted: rows.filter(row => row.sentAt).length,
        serverAcknowledged: rows.filter(row => row.acknowledgedAt).length,
        ...(campaign.channel === 'whatsapp' ? {
            delivered: rows.filter(row => row.deliveredAt).length,
            read: rows.filter(row => row.readAt).length,
        } : {}),
    }]);
}

