import type { CampaignSummary } from '../../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS } from '../../types/index.js';

export function completionNotice(summary: CampaignSummary, name: string = summary.id): string | undefined {
    if (summary.isTest || (summary.state !== 'Completed' && summary.state !== 'Failed')) return undefined;
    const headline = summary.state === 'Completed' ? '✅ Campaign finished successfully' : '❌ Campaign finished — nothing could be sent';
    const lines = [
        headline,
        '',
        `Campaign: ${name}`,
        `Channel: ${CAMPAIGN_CHANNEL_LABELS[summary.channel]}`,
        `Total people: ${summary.total}`,
        `Sent successfully: ${summary.completed}`,
        `Failed: ${summary.failed}`,
    ];
    if (summary.unknown) lines.push(`Needs review: ${summary.unknown}`);
    if (summary.skipped) lines.push(`Skipped: ${summary.skipped}`);
    return lines.join('\n');
}
