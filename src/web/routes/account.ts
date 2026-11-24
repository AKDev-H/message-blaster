import { HttpError } from '../http-error.js';
import { json } from '../http.js';
import type { App, Request, Route } from './route.js';

const AUDIT_PAGE_SIZE = 50;

export const accountRoutes: Route[] = [
    { method: 'GET', path: '/api/session', handle: ({ res, user }) => json(res, 200, { user }) },
    { method: 'GET', path: '/api/audit', admin: true, handle: auditPage },
];

function auditPage({ res, query }: Request, app: App): void {
    const from = timestamp(query.get('from'));
    const to = timestamp(query.get('to'));
    if (from !== undefined && to !== undefined && from > to) throw new HttpError(400, 'The audit range must start before it ends.');
    const range = { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
    json(res, 200, app.authStore.auditPage(pageNumber(query.get('page')), AUDIT_PAGE_SIZE, range));
}

function timestamp(value: string | null): number | undefined {
    if (value === null || value === '') return undefined;
    const time = Number(value);
    if (!Number.isSafeInteger(time) || time < 0) throw new HttpError(400, 'Invalid audit date range.');
    return time;
}

function pageNumber(value: string | null): number {
    if (value === null) return 1;
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, 'Invalid audit page.');
    return page;
}
