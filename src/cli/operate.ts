import type { Environment } from '../config/env.js';
import { runLiveCampaign, type DeliveryOptions, type RunMode } from '../services/live-campaign.service.js';
import type { Store } from '../store/index.js';
import { printPreview, printStatus } from './output.js';

export async function operate(store: Store, env: Environment, id: string, mode: RunMode, options: DeliveryOptions): Promise<void> {
    if (!options.live) return previewDryRun(store, id);
    const result = await runLiveCampaign(store, env, id, mode, options, recovered => {
        console.log(`${recovered} interrupted messages now require manual review.`);
    });
    if (!result) return;
    console.log(`Processed ${result.attempts} attempts during this run.`);
    printStatus(store, id);
    if (result.connectionError) throw result.connectionError;
}

function previewDryRun(store: Store, id: string): void {
    console.log('Dry run. Previewing the saved campaign.');
    printPreview(store, id, 20);
}
