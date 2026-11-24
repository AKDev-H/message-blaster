import { join } from 'node:path';
import type { Command } from 'commander';
import type { Environment } from '../../config/env.js';
import { exportCampaign } from '../../services/campaign/export.js';
import { importCampaign } from '../../services/campaign/import.js';
import { summarizeRecipients } from '../../services/campaign/summary.js';
import { generateExcel } from '../../services/excel/template.js';
import { recoverInterruptedCampaigns, type DeliveryOptions, type RunMode } from '../../services/live-campaign.service.js';
import type { Store } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { withDb } from '../context.js';
import { operate } from '../operate.js';
import { campaignId, channelOption, integer, liveCommand, workbookPath } from '../options.js';
import { printPreview, printStatus } from '../output.js';

interface ImportOptions {
    file?: string;
    template?: string;
    channel: CampaignChannel;
}

export function registerCampaignCommands(program: Command): void {
    registerImport(program);
    registerViews(program);
    registerControls(program);
    registerRuns(program);
    registerReviewAndExport(program);
}

function registerImport(program: Command): void {
    program.command('campaign:import').description('Validate and snapshot workbook rows into a new campaign')
        .argument('<id>', 'Campaign ID', campaignId)
        .addOption(channelOption())
        .option('--file <path>', 'Import workbook')
        .option('--template <path>', 'Fallback message template in a local UTF-8 file')
        .action((id: string, options: ImportOptions) => withDb((store, env) => importFromWorkbook(store, env, id, options)));
}

function registerViews(program: Command): void {
    program.command('campaign:preview').description('Show the saved recipients, messages and validation results')
        .argument('<id>', 'Campaign ID', campaignId)
        .option('--limit <count>', 'Rows to display', integer, 20)
        .action((id: string, { limit }: { limit: number }) => withDb(store => printPreview(store, id, limit)));

    program.command('campaign:status').description('Show campaign progress and available receipt totals')
        .argument('<id>', 'Campaign ID', campaignId)
        .option('--attempts', 'Show the durable attempt history')
        .action((id: string, { attempts }: { attempts?: boolean }) => withDb(store => {
            printStatus(store, id);
            if (attempts) console.table(store.listAttempts(id));
        }));
}

function registerControls(program: Command): void {
    program.command('campaign:recover').description('Reconcile interrupted campaigns before manual review')
        .action(() => withDb(async (store, env) => {
            const recovered = await recoverInterruptedCampaigns(store, env.DATABASE_URL);
            console.log(`Recovered campaign state. ${recovered} interrupted messages now require manual review.`);
        }));

    for (const control of ['pause', 'cancel'] as const) {
        program.command(`campaign:${control}`).description(`${control === 'pause' ? 'Pause' : 'Cancel'} a campaign`)
            .argument('<id>', 'Campaign ID', campaignId)
            .action((id: string) => withDb(store => {
                store[control](id);
                printStatus(store, id);
            }));
    }
}

function registerRuns(program: Command): void {
    for (const mode of ['start', 'resume'] as const) {
        liveCommand(program.command(`campaign:${mode}`).description(`${mode === 'start' ? 'Start' : 'Resume'} an approved campaign`))
            .action((id: string, options: DeliveryOptions) => withDb((store, env) => runCampaign(store, env, id, mode, options)));
    }
}

function registerReviewAndExport(program: Command): void {
    program.command('campaign:review').description('Record the verified outcome of a message under manual review')
        .argument('<record>', 'Record ID from campaign preview', integer)
        .requiredOption('--outcome <status>', 'Verified SENT or FAILED')
        .requiredOption('--note <text>', 'Reason and evidence for the decision')
        .action((record: number, { outcome, note }: { outcome: string; note: string }) => withDb(store => reviewMessage(store, record, outcome, note)));

    program.command('campaign:export').description('Export the campaign snapshot and results to a new workbook')
        .argument('<id>', 'Campaign ID', campaignId)
        .option('--output <path>', 'Output workbook path')
        .action((id: string, { output }: { output?: string }) => withDb(async store => {
            const path = output ?? join('storage', `${id}-results.xlsx`);
            await exportCampaign(store, id, path);
            console.log(`Exported ${id} to ${path}`);
        }));
}

async function importFromWorkbook(store: Store, env: Environment, id: string, options: ImportOptions): Promise<void> {
    const source = options.file ?? workbookPath(env, options.channel);
    if (!options.file) await generateExcel(source, options.channel);
    const template = options.template ? { templatePath: options.template } : {};
    const campaign = await importCampaign(store, env, id, { source, channel: options.channel, ...template });
    console.log(`Campaign ${id} (${campaign.channel}) is ${campaign.state}.`);
    console.table([summarizeRecipients(store.listMessages(id), campaign.channel)]);
}

function runCampaign(store: Store, env: Environment, id: string, mode: RunMode, options: DeliveryOptions): Promise<void> {
    const campaign = store.getCampaign(id);
    if (mode === 'start' && campaign.isTest) throw new Error(`Start test campaigns with ${campaign.channel}:test.`);
    return operate(store, env, id, mode, options);
}

function reviewMessage(store: Store, record: number, outcome: string, note: string): void {
    if ((outcome !== 'SENT' && outcome !== 'FAILED') || !note.trim() || note.length > 1_000) {
        throw new Error('Provide SENT or FAILED and a review note of up to 1,000 characters.');
    }
    store.review(record, outcome, note.trim());
    console.log(`Recorded manual review of message ${record}.`);
}
