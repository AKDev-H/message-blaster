import { HttpError } from '../http-error.js';
import { json } from '../http.js';
import type { App, Request, Route } from './route.js';

const AUDIT_PAGE_SIZE = 50;

export const accountRoutes: Route[] = [
    { method: 'GET', path: '/api/session', handle: ({ res, user }) => json(res, 200, { user }) },
    { method: 'GET', path: '/api/audit', admin: true, handle: auditPage },
];

function auditPage({ res, query }: Request, app: App): void {
    const before = auditCursor(query.get('before'));
    const events = app.authStore.listAudit(before, AUDIT_PAGE_SIZE + 1);
    const page = events.slice(0, AUDIT_PAGE_SIZE);
    json(res, 200, { events: page, next: events.length > AUDIT_PAGE_SIZE ? page.at(-1)?.id : null });
}

function auditCursor(cursor: string | null): number | undefined {
    if (cursor === null) return undefined;
    const before = Number(cursor);
    if (!Number.isSafeInteger(before) || before < 1) throw new HttpError(400, 'Invalid audit cursor.');
    return before;
}
