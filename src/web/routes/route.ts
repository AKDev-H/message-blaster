import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseEnvironment, Environment } from '../../config/env.js';
import type { WhatsAppLinker } from '../../services/whatsapp/link.js';
import type { CampaignChannel } from '../../types/index.js';
import type { Store } from '../../store/index.js';
import type { LiveUpdates } from '../live-updates.js';
import type { WebRunner } from '../runner.js';

export interface App {
    env: BaseEnvironment;
    db: DatabaseSync;
    store: Store;
    runner: WebRunner;
    whatsapp: WhatsAppLinker;
    updates: LiveUpdates;
    templates: Map<CampaignChannel | 'both', Promise<Buffer>>;
    settings(): Environment;
    snapshot(): unknown;
}

export interface Request {
    req: IncomingMessage;
    res: ServerResponse;
    params: string[];
    query: URLSearchParams;
}

export interface Route {
    method: string;
    path: string | RegExp;
    handle(request: Request, app: App): void | Promise<void>;
}

export function findRoute(routes: readonly Route[], method: string | undefined, pathname: string) {
    for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchPath(route.path, pathname);
        if (params) return { route, params };
    }
    return undefined;
}

function matchPath(path: string | RegExp, pathname: string): string[] | undefined {
    if (typeof path === 'string') return path === pathname ? [] : undefined;
    const match = path.exec(pathname);
    return match ? match.slice(1).map(value => value ?? '') : undefined;
}
