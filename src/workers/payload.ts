import type { Environment } from '../config/env.js';
import { readAttachment } from '../services/attachment.service.js';
import type { MessageRecord, Store } from '../store/index.js';
import type { OutgoingMessage } from '../types/index.js';
import { errorMessage, hasErrorCode } from '../utils/fs.util.js';

export type Payload = Omit<OutgoingMessage, 'id'>;
export type PreparedPayload = { payload: Payload } | PreparationFailure;

export interface PreparationFailure {
    error: string;
    transient: boolean;
}

type RetrySettings = Pick<Environment, 'MAX_RETRY_ATTEMPTS' | 'RETRY_DELAY_MS'>;

const MAX_RETRY_DELAY_MS = 3_600_000;
const TRANSIENT_FILE_ERRORS = ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT'];

export async function preparePayload(record: MessageRecord, attachmentDir: string): Promise<PreparedPayload> {
    const payload = textPayload(record);
    if (!record.pdfFilename) return { payload };
    try {
        const attachment = await readAttachment(attachmentDir, record.pdfFilename);
        if (record.attachmentHash !== attachment.sha256) return { error: 'Attachment error: PDF changed since import', transient: false };
        return { payload: { ...payload, attachment: { name: attachment.name, data: attachment.data } } };
    } catch (error) {
        return { error: `Attachment error: ${errorMessage(error, 'PDF validation failed')}`, transient: isTransientFileError(error) };
    }
}

export function finishPreparationFailure(store: Store, record: MessageRecord, failure: PreparationFailure, settings: RetrySettings): void {
    if (!failure.transient || record.attemptCount > settings.MAX_RETRY_ATTEMPTS) {
        store.finish(record.id, 'FAILED', failure.error);
        return;
    }
    const retryDelay = Math.min(MAX_RETRY_DELAY_MS, settings.RETRY_DELAY_MS * 2 ** (record.attemptCount - 1));
    store.finish(record.id, 'RETRY', failure.error, Date.now() + retryDelay);
}

function textPayload(record: MessageRecord): Payload {
    const payload: Payload = { phone: record.phone, text: record.message };
    if (record.email !== undefined) payload.email = record.email;
    if (record.subject !== undefined) payload.subject = record.subject;
    if (record.messageHtml !== undefined) payload.html = record.messageHtml;
    return payload;
}

function isTransientFileError(error: unknown): boolean {
    const cause = error instanceof Error ? error.cause : undefined;
    return hasErrorCode(error, ...TRANSIENT_FILE_ERRORS) || hasErrorCode(cause, ...TRANSIENT_FILE_ERRORS);
}
