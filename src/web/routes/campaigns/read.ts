import { exportCampaignWorkbook } from '../../../services/campaign/export.js';
import { groupDetail, groupListing } from '../../campaign-view.js';
import { json, sendWorkbook } from '../../http.js';
import { RECIPIENT_FILTERS, type RecipientFilter } from '../../../store/index.js';
import { HttpError } from '../../http-error.js';
import { readCampaignQuery } from '../../input/index.js';
import type { App, Request } from '../route.js';
import { findChannel, findGroup, pageNumber } from './context.js';

const LIST_PAGE_SIZE = 10;
const RECIPIENT_PAGE_SIZE = 25;

export function listGroups({ res, query }: Request, app: App): void {
    const filters = readCampaignQuery(query, LIST_PAGE_SIZE);
    const { groups, ...page } = app.store.listGroupPage(filters);
    const campaigns = groups.map(listing => groupListing(app, listing, filters.channel));
    json(res, 200, { ...(app.snapshot() as object), ...page, campaigns });
}

export function showGroup({ res, params }: Request, app: App): void {
    json(res, 200, groupDetail(app, findGroup(app, params[0]!)));
}

export function showChannel({ res, params, query }: Request, app: App): void {
    const { member } = findChannel(app, params);
    const recipients = app.store.listMessagePage(member.id, pageNumber(query), RECIPIENT_PAGE_SIZE, recipientFilter(query));
    json(res, 200, { campaign: app.runner.decorate(member), metrics: app.store.memberMetrics(member.id), ...recipients });
}

export async function exportChannel({ res, params, audit }: Request, app: App): Promise<void> {
    const { group, member, target } = findChannel(app, params);
    const workbook = await exportCampaignWorkbook(app.store, member.id);
    audit.record('campaign.export', 'success', target);
    sendWorkbook(res, workbook, `${group.slug}-${member.channel}-results.xlsx`);
}

function recipientFilter(query: URLSearchParams): RecipientFilter | undefined {
    const status = query.get('status') || undefined;
    if (status && !Object.hasOwn(RECIPIENT_FILTERS, status)) throw new HttpError(400, `Unknown recipient filter "${status}".`);
    return status as RecipientFilter | undefined;
}
