import type { Command } from 'commander';
import type { CampaignChannel } from '../../types/index.js';
import { normalizeEmail } from '../../utils/email.util.js';
import { normalizePhone } from '../../utils/phone.util.js';
import { withDb } from '../context.js';
import { channelOption } from '../options.js';

export function registerConsentCommands(program: Command): void {
    program.command('consent:withdraw').description('Block a recipient from future submissions and skip queued messages')
        .argument('<recipient>', 'Recipient phone number or email address')
        .addOption(channelOption())
        .action((recipient: string, { channel }: { channel: CampaignChannel }) => withDb((store, env) => {
            const address = channel === 'gmail' ? normalizeEmail(recipient) : normalizePhone(recipient, env.DEFAULT_COUNTRY);
            console.log(`Recorded withdrawal. Skipped ${store.withdraw(address, channel)} queued messages.`);
        }));
}
