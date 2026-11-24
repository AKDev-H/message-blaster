import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Environment } from '../config/env.js';
import type { MessageTransport, OutgoingMessage } from '../types/index.js';
import { readAttachment } from '../services/attachment.service.js';
import type { MessageRecord, Store } from '../services/message.service.js';

type WorkerSettings = Pick<
    Environment,
    'ATTACHMENTS_DIR' | 'SENDER_CONCURRENCY' | 'MAX_MESSAGES_PER_RUN' |
    'MESSAGE_DELAY_MS' | 'MAX_RETRY_ATTEMPTS' | 'RETRY_DELAY_MS'
>;

const WORKER_POLL_MS = 1_000;
const MAX_RETRY_DELAY_MS = 3_600_000;
const TRANSIENT_FILE_ERRORS = new Set(['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT']);

export async function runCampaign(
    store: Store,
    id: string,
    settings: WorkerSettings,
    transport: MessageTransport,
    logger: Logger,
    signal: AbortSignal,
): Promise<number> {
    const active = new Set<Promise<void>>();
    let attempted = 0;
    let nextSendAt = 0;
    let workerFailure: unknown;
    try {
        while (!signal.aborted && attempted < settings.MAX_MESSAGES_PER_RUN) {
            if (workerFailure) throw workerFailure;
            if (store.getCampaign(id).state !== 'Running') break;
            if (active.size >= settings.SENDER_CONCURRENCY) {
                await Promise.race(active);
                continue;
            }
            const candidate = store.peek(id);
            if (!candidate) {
                if (active.size) {
                    await Promise.race(active);
                    continue;
                }
                const due = store.nextAvailableAt(id);
                if (due === undefined) break;
                await pause(Math.max(5, due - Date.now()), signal);
                continue;
            }
            if (!transport.isReady) {
                if (!await waitForReconnect(transport, signal)) break;
                continue;
            }
            const pacingWait = nextSendAt - Date.now();
            if (pacingWait > 0) {
                await pause(pacingWait, signal);
                continue;
            }
            const result = await preparePayload(candidate, settings.ATTACHMENTS_DIR);
            if (signal.aborted) break;
            if (!transport.isReady) continue;
            const transportId = transport.createMessageId?.() ?? `3EB0${randomBytes(9).toString('hex').toUpperCase()}`;
            const claimed = store.claim(id, candidate.id, transportId);
            if (!claimed) continue;
            attempted += 1;
            if ('error' in result) {
                finishPreparationFailure(store, claimed, result, settings);
                continue;
            }
            if (!store.canSubmit(claimed.id)) {
                store.finish(claimed.id, 'RETRY', 'Campaign paused before submission', Date.now());
                continue;
            }
            nextSendAt = Date.now() + settings.MESSAGE_DELAY_MS;
            const task = submit(store, claimed.id, { id: claimed.transportMessageId, ...result.payload }, transport, logger)
                .catch(error => { workerFailure ??= error; })
                .finally(() => { active.delete(task); });
            active.add(task);
        }
    } finally {
        await Promise.all(active);
    }
    if (workerFailure) throw workerFailure;

    const final = store.settleCampaign(id);
    if (final.state === 'Running') store.pauseIfRunning(id);
    return attempted;
}

async function waitForReconnect(transport: MessageTransport, signal: AbortSignal): Promise<boolean> {
    if (!transport.waitUntilReady) return false;
    const timeout = AbortSignal.timeout(WORKER_POLL_MS);
    try {
        await transport.waitUntilReady(AbortSignal.any([signal, timeout]));
        if (!transport.isReady) await pause(100, signal);
        return !signal.aborted;
    } catch {
        return !signal.aborted && timeout.aborted;
    }
}

async function pause(ms: number, signal: AbortSignal) {
    try {
        await sleep(Math.min(ms, WORKER_POLL_MS), undefined, { signal });
    } catch (error) {
        if (!signal.aborted) throw error;
    }
}

interface PreparationFailure {
    error: string;
    transient: boolean;
}

type PreparedPayload = { payload: Omit<OutgoingMessage, 'id'> } | PreparationFailure;

function finishPreparationFailure(
    store: Store,
    record: MessageRecord,
    failure: PreparationFailure,
    settings: WorkerSettings,
): void {
    if (!failure.transient || record.attemptCount > settings.MAX_RETRY_ATTEMPTS) {
        store.finish(record.id, 'FAILED', failure.error);
        return;
    }

    const retryDelay = Math.min(MAX_RETRY_DELAY_MS, settings.RETRY_DELAY_MS * 2 ** (record.attemptCount - 1));
    store.finish(record.id, 'RETRY', failure.error, Date.now() + retryDelay);
}

function isTransientFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && TRANSIENT_FILE_ERRORS.has(String(error.code));
}

async function preparePayload(record: MessageRecord, attachmentDir: string): Promise<PreparedPayload> {
    const payload: Omit<OutgoingMessage, 'id'> = { phone: record.phone, text: record.message };
    if (record.email !== undefined) payload.email = record.email;
    if (record.subject !== undefined) payload.subject = record.subject;
    if (record.messageHtml !== undefined) payload.html = record.messageHtml;
    if (!record.pdfFilename) return { payload };
    try {
        const attachment = await readAttachment(attachmentDir, record.pdfFilename);
        if (record.attachmentHash !== attachment.sha256) {
            return { error: 'Attachment error: PDF changed since import', transient: false };
        }
        payload.attachment = { name: attachment.name, data: attachment.data };
        return { payload };
    } catch (error) {
        const transient = isTransientFileError(error) || (error instanceof Error && isTransientFileError(error.cause));
        const detail = error instanceof Error ? error.message : 'PDF validation failed';
        return { error: `Attachment error: ${detail}`, transient };
    }
}

async function submit(
    store: Store,
    recordId: number,
    message: OutgoingMessage,
    transport: MessageTransport,
    logger: Logger,
) {
    let result: Awaited<ReturnType<MessageTransport['send']>>;
    try {
        result = await transport.send(message);
    } catch {
        store.finish(recordId, 'UNKNOWN', 'Transport outcome uncertain. Manual review required.');
        logger.warn({ recordId }, 'Message submission requires manual review');
        return;
    }
    store.finish(recordId, 'SENT', undefined, undefined, result?.acknowledged);
    logger.info({ recordId }, 'Message submitted to transport');
}
