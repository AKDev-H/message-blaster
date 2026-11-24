import type { Command } from 'commander';
import type { PairCandidate } from '../../store/index.js';
import { withDb } from '../context.js';
import { campaignId } from '../options.js';

interface GroupOptions {
    slug?: string;
    force?: boolean;
}

export function registerGroupCommands(program: Command): void {
    program.command('campaign:pairs').description('List split Gmail/WhatsApp campaigns that may belong together, with the evidence for each')
        .action(() => withDb(store => printPairs(store.pairCandidates())));

    program.command('campaign:group').description('Show a confirmed Gmail campaign and WhatsApp campaign as one dashboard campaign')
        .argument('<gmail-id>', 'Gmail campaign ID', campaignId)
        .argument('<whatsapp-id>', 'WhatsApp campaign ID', campaignId)
        .option('--slug <slug>', 'Link for the combined campaign (defaults to the shared name)', campaignId)
        .option('--force', 'Group them even without evidence that they were created together')
        .action((gmail: string, whatsapp: string, options: GroupOptions) => withDb(store => {
            const slug = options.slug ?? defaultSlug(gmail, whatsapp);
            const group = store.groupPair(gmail, whatsapp, slug, Boolean(options.force));
            console.log(`Grouped ${gmail} and ${whatsapp} as /campaigns/${group.slug}. Campaign IDs and history are unchanged.`);
            if (group.contactIdentity === 'none') console.log('People counts stay per channel because the two imports do not share a workbook.');
        }));
}

function printPairs(pairs: readonly PairCandidate[]): void {
    if (!pairs.length) {
        console.log('No split Gmail/WhatsApp campaigns were found.');
        return;
    }
    console.table(pairs.map(pair => ({
        slug: pair.slug, gmail: pair.gmail, whatsapp: pair.whatsapp,
        'same workbook': pair.sameWorkbook ? 'yes' : 'no',
        'created together': pair.createdTogether ? 'yes' : 'no',
        'link free': pair.slugAvailable ? 'yes' : 'no',
        evidence: pair.sameWorkbook || pair.createdTogether ? 'likely pair' : 'name only — check before grouping',
    })));
    console.log('Nothing has been merged. Confirm a pair with: npm run campaign:group -- <gmail-id> <whatsapp-id>');
}

function defaultSlug(gmail: string, whatsapp: string): string {
    const base = gmail.replace(/-gmail$/u, '');
    if (base !== gmail && whatsapp === `${base}-whatsapp`) return base;
    throw new Error('Choose the combined campaign link with --slug.');
}
