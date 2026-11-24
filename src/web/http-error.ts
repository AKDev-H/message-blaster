import { AiError } from '../services/ai.service.js';
import { SecretError } from '../services/secret.service.js';
import { CampaignExistsError, ConflictError, NotFoundError } from '../errors.js';

export type DraftField = 'id' | 'channel' | 'workbook' | 'recipients' | 'subject' | 'script' | 'attachment'
    | 'gmailUser' | 'gmailPassword' | 'country' | 'delay' | 'testRecipient';

export class HttpError extends Error {
    constructor(readonly status: number, message: string, readonly field?: DraftField) {
        super(message);
    }
}

export function publicError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof CampaignExistsError) return new HttpError(409, 'A campaign already uses this name.', 'id');
    if (error instanceof NotFoundError) return new HttpError(404, error.message);
    if (error instanceof ConflictError) return new HttpError(409, error.message);
    if (error instanceof AiError) return new HttpError(502, error.message);
    if (error instanceof SecretError) return new HttpError(500, error.message);
    return new HttpError(500, 'Something went wrong. Try again.');
}

export async function orFail<T>(status: number, fallback: string, step: () => T | Promise<T>, field?: DraftField): Promise<T> {
    try {
        return await step();
    } catch (error) {
        throw new HttpError(status, error instanceof Error ? error.message : fallback, field);
    }
}
