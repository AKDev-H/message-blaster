import type { IncomingMessage } from 'node:http';
import { HttpError } from '../http-error.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 256 * 1024;
const MAX_JSON_BYTES = 16 * 1024;

export type JsonBody = Record<string, unknown>;

export async function readForm(req: IncomingMessage): Promise<FormData> {
    const type = req.headers['content-type'];
    if (!type?.startsWith('multipart/form-data;')) throw new HttpError(415, 'Upload the file using a multipart form.');
    const body = await readBody(req, MAX_MULTIPART_BYTES);
    try {
        return await new Response(body, { headers: { 'content-type': type } }).formData();
    } catch {
        throw new HttpError(400, 'The upload form could not be read.');
    }
}

export async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<JsonBody> {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send a JSON request.');
    const parsed = parseJson(await readBody(req, limit));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonBody;
    throw new HttpError(400, 'The request must contain a JSON object.');
}

function parseJson(body: Uint8Array): unknown {
    try {
        return JSON.parse(new TextDecoder().decode(body));
    } catch {
        throw new HttpError(400, 'The request contains invalid JSON.');
    }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    if (Number(req.headers['content-length']) > limit) throw tooLarge(req);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > limit) throw tooLarge(req);
        chunks.push(chunk);
    }
    return Uint8Array.from(Buffer.concat(chunks, size));
}

function tooLarge(req: IncomingMessage): HttpError {
    req.resume();
    return new HttpError(413, 'The upload is too large.');
}
