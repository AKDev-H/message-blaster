import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthUser } from '../auth/store.js';
import { loadAssets, loadStatusPages, type Asset, type Assets, type StatusPage, type StatusPages } from './assets.js';
import { HttpError } from './http-error.js';
import { sendAsset, sendError, sendPage } from './http.js';
import { groupExists } from './routes/campaigns/index.js';
import { requireRole } from './routes/index.js';
import type { App } from './routes/route.js';

const MAINTENANCE_RETRY_SECONDS = 120;
const CAMPAIGN_PAGE = /^\/campaigns\/([^/]+)$/u;
const ADMIN_PAGES = new Set(['/audit']);
const PUBLIC_ASSETS = new Set(['/auth.css', '/login.mjs', '/login-bg.jpg', '/logo.png', '/brand.css']);
const PUBLIC_ASSET_PREFIXES = ['/fonts/', '/vendor/', '/favicon.', '/manifest.webmanifest'];
const PAGE_PREVIEWS: Record<string, [StatusPage, number]> = {
    '/errors/404': ['not-found', 404],
    '/errors/500': ['server-error', 500],
    '/errors/maintenance': ['maintenance', 503],
};

export class Site {
    private constructor(private readonly assets: Assets, private readonly pages: StatusPages) {}

    static async load(): Promise<Site> {
        return new Site(await loadAssets(), await loadStatusPages());
    }

    servePublicAsset(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
        const asset = this.asset(req, pathname);
        if (!asset || !isPublicAsset(pathname)) return false;
        sendAsset(req, res, asset);
        return true;
    }

    servePage(req: IncomingMessage, res: ServerResponse, pathname: string, user: AuthUser, app: App): boolean {
        if (req.method !== 'GET') return false;
        const asset = this.assets.get(pathname);
        if (asset) {
            if (ADMIN_PAGES.has(pathname)) requireRole(true, { user });
            if (asset.type.startsWith('text/html')) sendPage(res, 200, asset.body);
            else sendAsset(req, res, asset);
            return true;
        }
        const campaign = CAMPAIGN_PAGE.exec(pathname);
        if (campaign) {
            if (!groupExists(app, decodeSlug(campaign[1]!))) throw new HttpError(404, 'This campaign does not exist.');
            sendPage(res, 200, this.assets.get('/')!.body);
            return true;
        }
        const preview = PAGE_PREVIEWS[pathname];
        if (!preview) return false;
        sendPage(res, preview[1], this.pages.get(preview[0])!);
        return true;
    }

    serveMaintenance(req: IncomingMessage, res: ServerResponse, pathname: string): void {
        const asset = this.asset(req, pathname);
        if (asset && !asset.type.startsWith('text/html')) return sendAsset(req, res, asset);
        res.setHeader('Retry-After', String(MAINTENANCE_RETRY_SECONDS));
        if (pathname.startsWith('/api/')) return sendError(res, new HttpError(503, 'Message Blaster is down for maintenance. Try again in a few minutes.'));
        sendPage(res, 503, this.pages.get('maintenance')!);
    }

    serveFailure(req: IncomingMessage, res: ServerResponse, failure: HttpError): void {
        if (res.headersSent) return void res.destroy();
        if (wantsPage(req) && failure.status === 404) return sendPage(res, 404, this.pages.get('not-found')!);
        if (wantsPage(req) && failure.status >= 500) return sendPage(res, failure.status, this.pages.get('server-error')!);
        sendError(res, failure);
    }

    private asset(req: IncomingMessage, pathname: string): Asset | undefined {
        return req.method === 'GET' ? this.assets.get(pathname) : undefined;
    }
}

function isPublicAsset(pathname: string): boolean {
    return PUBLIC_ASSETS.has(pathname) || PUBLIC_ASSET_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function wantsPage(req: IncomingMessage): boolean {
    const path = req.url ?? '';
    return req.method === 'GET' && !path.startsWith('/api/') && String(req.headers.accept ?? '').includes('text/html');
}

function decodeSlug(encoded: string): string {
    try {
        return decodeURIComponent(encoded);
    } catch {
        return '';
    }
}
