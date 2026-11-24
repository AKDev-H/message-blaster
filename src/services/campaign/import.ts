import { readFile } from 'node:fs/promises';
import type { Environment } from '../../config/env.js';
import { MAX_EMAIL_LENGTH } from '../../config/constants.js';
import type { Store } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { readExcel } from '../excel/read.js';
import { prepareRows } from './prepare-rows.js';

export interface CampaignOptions {
    source: string;
    templatePath?: string;
    channel?: CampaignChannel;
}

export async function importCampaign(store: Store, env: Environment, id: string, options: CampaignOptions) {
    const channel = options.channel ?? 'whatsapp';
    const template = options.templatePath ? await readTemplate(options.templatePath) : '';
    const rows = (await readExcel(options.source, channel)).filter(row => !row.campaignId || row.campaignId === id);
    if (rows.length === 0) throw new Error(`No rows match campaign ${id}. Check the workbook Campaign ID column.`);
    return store.importCampaign(id, await prepareRows(store, env, id, rows, template, channel), false, channel);
}

async function readTemplate(path: string): Promise<string> {
    const template = await readFile(path, 'utf8');
    if (template.length > MAX_EMAIL_LENGTH) throw new Error('Campaign template exceeds 32,767 characters.');
    return template;
}
