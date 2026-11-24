import { CAMPAIGN_STATUS_FILTERS, type CampaignQuery, type CampaignStatusFilter } from '../../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../../types/index.js';
import { HttpError } from '../http-error.js';

export function readCampaignQuery(query: URLSearchParams, pageSize: number): CampaignQuery {
    const status = query.get('status') || undefined;
    const channel = query.get('channel') || undefined;
    const page = Number(query.get('page') ?? '1');
    if (status && !(CAMPAIGN_STATUS_FILTERS as readonly string[]).includes(status)) throw new HttpError(400, `Unknown status filter "${status}".`);
    if (channel && !Object.hasOwn(CAMPAIGN_CHANNEL_LABELS, channel)) throw new HttpError(400, `Unknown channel "${channel}".`);
    if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, 'Page must be a whole number from 1.');
    return {
        page, pageSize,
        ...(status ? { status: status as CampaignStatusFilter } : {}),
        ...(channel ? { channel: channel as CampaignChannel } : {}),
    };
}
