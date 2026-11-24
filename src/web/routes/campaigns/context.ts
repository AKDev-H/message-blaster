import type { ServerResponse } from 'node:http';
import type { CampaignGroup, CampaignSummary } from '../../../store/index.js';
import type { CampaignChannel } from '../../../types/index.js';
import { HttpError } from '../../http-error.js';
import { json } from '../../http.js';
import { readCampaignId, readChannel, readJson, type JsonBody } from '../../input/index.js';
import type { App, Request } from '../route.js';

export interface ChannelContext {
    group: CampaignGroup;
    member: CampaignSummary;
    target: string;
}

const SLUG = '([A-Za-z0-9_-]+)';
const CHANNEL = '(gmail|whatsapp)';

export function groupPath(suffix = ''): RegExp {
    return new RegExp(`^/api/campaign-groups/${SLUG}${suffix}$`, 'u');
}

export function channelPath(suffix = ''): RegExp {
    return groupPath(`/${CHANNEL}${suffix}`);
}

export function findGroup(app: App, slug: string): CampaignGroup {
    return app.store.campaignGroup(readCampaignId(slug));
}

export function groupExists(app: App, slug: string): boolean {
    try {
        findGroup(app, slug);
        return true;
    } catch {
        return false;
    }
}

export function findChannel(app: App, params: readonly string[]): ChannelContext {
    const group = findGroup(app, params[0]!);
    const member = app.store.groupMember(group, readChannel(params[1]));
    return { group, member, target: target(group, member.channel) };
}

export async function channelRequest(request: Request, app: App): Promise<ChannelContext & { body: JsonBody }> {
    return { ...findChannel(app, request.params), body: await readJson(request.req) };
}

export function target(group: CampaignGroup, channel: CampaignChannel): string {
    return `${group.slug}/${channel}`;
}

export function ensureStopped(app: App, ids: readonly string[]): void {
    if (ids.some(id => app.runner.isActive(id))) throw new HttpError(409, 'Wait for the campaign worker to finish stopping.');
}

export function respondChanged(app: App, res: ServerResponse, body: object, status = 200): void {
    app.updates.changed();
    json(res, status, body);
}

export function pageNumber(query: URLSearchParams): number {
    const requested = Number(query.get('page') ?? '1');
    return Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
}
