import { mkdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { loadEnv, type Environment } from '../../config/env.js';
import { backupDatabase } from '../../database/connection.js';
import { generateExcel } from '../../services/excel/template.js';
import type { CampaignChannel } from '../../types/index.js';
import { withDb } from '../context.js';
import { channelOption, workbookPath } from '../options.js';

export function registerSetupCommands(program: Command): void {
    program.command('setup').description('Initialize local directories, database and sample workbook')
        .action(() => withDb((_store, env) => setUp(env)));

    program.command('excel:generate').description('Create a blank-ready template with an ineligible example row')
        .addOption(channelOption())
        .option('--file <path>', 'Workbook path')
        .action(generateWorkbook);

    program.command('db:backup').description('Create a consistent SQLite backup at a new destination')
        .argument('<path>', 'Backup destination')
        .action((path: string) => withDb(async (_store, _env, db) => {
            await backupDatabase(db, path);
            console.log(`Backup saved to ${path}`);
        }));
}

async function setUp(env: Environment): Promise<void> {
    await Promise.all([env.AUTH_DIR, env.LOG_DIR, env.ATTACHMENTS_DIR].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
    const created = await generateExcel(env.EXCEL_FILE);
    console.log(created ? `Created sample workbook ${env.EXCEL_FILE}` : `Using existing workbook ${env.EXCEL_FILE}`);
    console.log(`Database ready at ${env.DATABASE_URL}`);
}

async function generateWorkbook({ file, channel }: { file?: string; channel: CampaignChannel }): Promise<void> {
    const path = file ?? workbookPath(loadEnv(), channel);
    console.log(await generateExcel(path, channel) ? `Created ${path}` : `Workbook already exists at ${path}`);
}
