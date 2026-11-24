import { element, number } from '../shared/ui.mjs';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export const RECIPIENT_STATUS_LABELS = {
    PENDING: 'Queued', VALIDATING: 'Queued', QUEUED: 'Queued', SENDING: 'Processing', SENT: 'Sent',
    DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Failed', SKIPPED: 'Skipped', UNKNOWN: 'Needs review',
};
export const COUNT_KEYS = ['queued', 'processing', 'completed', 'failed', 'unknown', 'skipped'];
export const COUNT_LABELS = {
    queued: 'Queued', processing: 'Processing', completed: 'Completed',
    failed: 'Failed', unknown: 'Needs review', skipped: 'Skipped',
};

export const statusOf = campaign => campaign.runStatus || campaign.state;
export const isActive = campaign => campaign.runActive || campaign.state === 'Running' || campaign.processing > 0;
const settledCount = campaign => campaign.completed + campaign.failed + campaign.unknown + campaign.skipped;

export function badge(status) {
    return element('span', `badge ${status.toLowerCase().replaceAll(' ', '-')}`, status);
}

export function formatDate(value) {
    const time = new Date(value);
    return Number.isNaN(time.valueOf()) ? '—' : dateFormat.format(time);
}

export function progressBar(campaign) {
    const meter = element('progress');
    meter.max = Math.max(1, campaign.total);
    meter.value = settledCount(campaign);
    meter.setAttribute('aria-label', `Progress for ${campaign.id}`);
    return meter;
}

export function progressText(campaign) {
    return `${number.format(settledCount(campaign))} / ${number.format(campaign.total)}`;
}
