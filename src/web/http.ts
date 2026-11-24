import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachmentMimeType } from '../services/attachment.service.js';
import { HttpError } from './http-error.js';

const EXCEL_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DASHBOARD_POLICY = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PDF_POLICY = "default-src 'none'; frame-ancestors 'self'";
const SANDBOXED_FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'";

export function respond(res: ServerResponse, status: number, body: Buffer | string, contentType: string): void {
    res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

/**
 * Static files are cached by the browser but checked with the server on every load (`no-cache`).
 * An unchanged file costs an empty 304; a changed file after a redeploy has a new ETag and is sent in full.
 */
export function sendAsset(req: IncomingMessage, res: ServerResponse, asset: { body: Buffer; type: string; etag: string }): void {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', asset.etag);
    if (matchesTag(req.headers['if-none-match'], asset.etag)) {
        res.writeHead(304).end();
        return;
    }
    respond(res, 200, asset.body, asset.type);
}

function matchesTag(header: string | undefined, etag: string): boolean {
    return Boolean(header) && header!.split(',').some(tag => tag.trim().replace(/^W\//u, '') === etag);
}

export function json(res: ServerResponse, status: number, data: unknown): void {
    respond(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

export function noContent(res: ServerResponse): void {
    res.writeHead(204).end();
}

export function sendWorkbook(res: ServerResponse, data: Buffer, name: string): void {
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    respond(res, 200, data, EXCEL_TYPE);
}

export function sendAttachment(res: ServerResponse, name: string, data: Buffer, download: boolean): void {
    const type = attachmentMimeType(name);
    res.setHeader('Content-Security-Policy', type === 'application/pdf' ? PDF_POLICY : SANDBOXED_FILE_POLICY);
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    respond(res, 200, data, type.startsWith('text/') ? `${type}; charset=utf-8` : type);
}

export function sendPage(res: ServerResponse, status: number, body: Buffer): void {
    respond(res, status, body, 'text/html; charset=utf-8');
}

export function sendError(res: ServerResponse, error: HttpError): void {
    json(res, error.status, { error: error.message, ...(error.field ? { field: error.field } : {}) });
}

export function setSecurityHeaders(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', DASHBOARD_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
}

export function validateOrigin(req: IncomingMessage, port: number, isApiCall: boolean): void {
    const { host } = req.headers;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Open the dashboard at its local address.');
    if (isApiCall && !isSameOrigin(req, host)) throw new HttpError(403, 'This request must come from the dashboard.');
}

function isSameOrigin(req: IncomingMessage, host: string): boolean {
    const { origin } = req.headers;
    const crossSite = ['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']));
    return (origin === undefined || origin === `http://${host}`) && !crossSite;
}
