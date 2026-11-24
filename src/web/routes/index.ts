import { HttpError } from '../http-error.js';
import { accountRoutes } from './account.js';
import { campaignRoutes } from './campaigns/index.js';
import { fileRoutes } from './files.js';
import { findRoute, type App, type Request } from './route.js';
import { settingsRoutes } from './settings.js';

const ROUTES = [...accountRoutes, ...campaignRoutes, ...fileRoutes, ...settingsRoutes];

export async function dispatch(method: string | undefined, pathname: string, request: Omit<Request, 'params'>, app: App): Promise<void> {
    const match = findRoute(ROUTES, method, pathname);
    if (!match) throw new HttpError(404, 'This page does not exist.');
    requireRole(match.route.admin, request);
    await match.route.handle({ ...request, params: match.params }, app);
}

export function requireRole(adminOnly: boolean | undefined, { user }: Pick<Request, 'user'>): void {
    if (adminOnly && user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
}
