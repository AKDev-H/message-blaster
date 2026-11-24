import { Command, CommanderError } from 'commander';
import { registerCampaignCommands } from './commands/campaign.js';
import { registerConsentCommands } from './commands/consent.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerTestCommands } from './commands/test.js';
import { registerWhatsAppCommands } from './commands/whatsapp.js';

export async function runCli(argv: string[]): Promise<void> {
    const program = new Command()
        .name('message-blaster')
        .description('Prepare and operate opted-in WhatsApp and Gmail campaigns.')
        .showHelpAfterError()
        .exitOverride();
    registerAllCommands(program);
    await parse(program, argv);
}

function registerAllCommands(program: Command): void {
    registerSetupCommands(program);
    registerWhatsAppCommands(program);
    registerCampaignCommands(program);
    registerTestCommands(program);
    registerConsentCommands(program);
}

async function parse(program: Command, argv: string[]): Promise<void> {
    try {
        await program.parseAsync(argv);
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        process.exitCode = error.exitCode;
    }
}
