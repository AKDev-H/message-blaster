import { HttpError } from '../http-error.js';
import { readCampaignId } from '../input/index.js';
import { accountRoutes } from './account.js';
import { campaignGroupRoutes } from './campaign-groups.js';
import { CAMPAIGN_PATH, campaignRoutes } from './campaigns.js';
import { fileRoutes } from './files.js';
import { findRoute, type App, type Request } from './route.js';
import { settingsRoutes } from './settings.js';

const ROUTES = [...accountRoutes, ...campaignGroupRoutes, ...campaignRoutes, ...fileRoutes, ...settingsRoutes];

export async function dispatch(method: string | undefined, pathname: string, request: Omit<Request, 'params'>, app: App): Promise<void> {
    const match = findRoute(ROUTES, method, pathname);
    if (!match) throw notFound(pathname);
    requireRole(match.route.admin, request);
    await match.route.handle({ ...request, params: match.params }, app);
}

export function requireRole(adminOnly: boolean | undefined, { user }: Pick<Request, 'user'>): void {
    if (adminOnly && user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
}

function notFound(pathname: string): HttpError {
    const campaign = CAMPAIGN_PATH.exec(pathname);
    if (campaign) readCampaignId(campaign[1]!);
    return new HttpError(404, campaign ? 'This action does not exist.' : 'This page does not exist.');
}
