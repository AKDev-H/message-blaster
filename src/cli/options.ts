import { InvalidArgumentError, Option, type Command } from 'commander';
import { CAMPAIGN_ID } from '../config/constants.js';
import type { BaseEnvironment } from '../config/env.js';
import type { CampaignChannel } from '../types/index.js';

export function campaignId(value: string): string {
    if (!CAMPAIGN_ID.test(value)) throw new InvalidArgumentError('Use 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.');
    return value;
}

export function integer(value: string): number {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Use a non-negative integer.');
    return Number(value);
}

export function channelOption(): Option {
    return new Option('--channel <channel>', 'Campaign channel').choices(['whatsapp', 'gmail']).default('whatsapp');
}

export function liveCommand(command: Command): Command {
    return command.argument('<id>', 'Campaign ID', campaignId)
        .option('--live', 'Use live delivery for the campaign channel')
        .option('--approve <id>', 'Explicitly approve the named campaign for this run', campaignId);
}

export function workbookPath(env: Pick<BaseEnvironment, 'EXCEL_FILE' | 'GMAIL_EXCEL_FILE'>, channel: CampaignChannel): string {
    return channel === 'gmail' ? env.GMAIL_EXCEL_FILE : env.EXCEL_FILE;
}
