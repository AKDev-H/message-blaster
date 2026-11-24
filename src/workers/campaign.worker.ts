import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Environment } from '../config/env.js';
import type { ClaimedMessage, MessageRecord, Store } from '../store/index.js';
import type { MessageTransport, OutgoingMessage } from '../types/index.js';
import { finishPreparationFailure, preparePayload, type Payload, type PreparedPayload } from './payload.js';

type WorkerSettings = Pick<
    Environment,
    'ATTACHMENTS_DIR' | 'SENDER_CONCURRENCY' | 'MAX_MESSAGES_PER_RUN' | 'MESSAGE_DELAY_MS' | 'MAX_RETRY_ATTEMPTS' | 'RETRY_DELAY_MS'
>;

const WORKER_POLL_MS = 1_000;

export async function runCampaign(store: Store, id: string, settings: WorkerSettings, transport: MessageTransport,
    logger: Logger, signal: AbortSignal): Promise<number> {
    const run = new CampaignRun(store, id, settings, transport, logger, signal);
    try {
        let sending = true;
        while (sending) sending = run.canContinue() && await run.step();
    } finally {
        await run.waitForSubmissions();
    }
    run.throwIfFailed();
    return run.finish();
}

class CampaignRun {
    private readonly submissions = new Set<Promise<void>>();
    private attempted = 0;
    private nextSendAt = 0;
    private failure: unknown;

    constructor(
        private readonly store: Store,
        private readonly id: string,
        private readonly settings: WorkerSettings,
        private readonly transport: MessageTransport,
        private readonly logger: Logger,
        private readonly signal: AbortSignal,
    ) {}

    canContinue(): boolean {
        return !this.signal.aborted && this.attempted < this.settings.MAX_MESSAGES_PER_RUN;
    }

    async step(): Promise<boolean> {
        this.throwIfFailed();
        if (this.store.getCampaign(this.id).state !== 'Running') return false;
        if (this.submissions.size >= this.settings.SENDER_CONCURRENCY) return this.waitForFreeSlot();
        const candidate = this.store.peek(this.id);
        if (!candidate) return this.waitForQueuedMessage();
        if (!this.transport.isReady) return waitForReconnect(this.transport, this.signal);
        if (await this.waitForPacing()) return true;
        return this.attempt(candidate);
    }

    throwIfFailed(): void {
        if (this.failure) throw this.failure;
    }

    async waitForSubmissions(): Promise<void> {
        await Promise.all(this.submissions);
    }

    finish(): number {
        if (this.store.settleCampaign(this.id).state === 'Running') this.store.pauseIfRunning(this.id);
        return this.attempted;
    }

    private async waitForFreeSlot(): Promise<boolean> {
        await Promise.race(this.submissions);
        return true;
    }

    private async waitForQueuedMessage(): Promise<boolean> {
        if (this.submissions.size) return this.waitForFreeSlot();
        const due = this.store.nextAvailableAt(this.id);
        if (due === undefined) return false;
        await pause(Math.max(5, due - Date.now()), this.signal);
        return true;
    }

    private async waitForPacing(): Promise<boolean> {
        const remaining = this.nextSendAt - Date.now();
        if (remaining <= 0) return false;
        await pause(remaining, this.signal);
        return true;
    }

    private async attempt(candidate: MessageRecord): Promise<boolean> {
        const prepared = await preparePayload(candidate, this.settings.ATTACHMENTS_DIR);
        if (this.signal.aborted) return false;
        if (!this.transport.isReady) return true;
        const claimed = this.store.claim(this.id, candidate.id, this.newTransportId());
        if (!claimed) return true;
        this.attempted += 1;
        this.handOff(claimed, prepared);
        return true;
    }

    private handOff(claimed: ClaimedMessage, prepared: PreparedPayload): void {
        if ('error' in prepared) return finishPreparationFailure(this.store, claimed, prepared, this.settings);
        if (!this.store.canSubmit(claimed.id)) return this.store.finish(claimed.id, 'RETRY', 'Campaign paused before submission', Date.now());
        this.submitInBackground(claimed, prepared.payload);
    }

    private submitInBackground(claimed: ClaimedMessage, payload: Payload): void {
        this.nextSendAt = Date.now() + this.settings.MESSAGE_DELAY_MS;
        const message = { id: claimed.transportMessageId, ...payload };
        const task = submit(this.store, claimed.id, message, this.transport, this.logger)
            .catch(error => { this.failure ??= error; })
            .finally(() => { this.submissions.delete(task); });
        this.submissions.add(task);
    }

    private newTransportId(): string {
        return this.transport.createMessageId?.() ?? `3EB0${randomBytes(9).toString('hex').toUpperCase()}`;
    }
}

async function submit(store: Store, recordId: number, message: OutgoingMessage, transport: MessageTransport, logger: Logger) {
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

async function pause(ms: number, signal: AbortSignal): Promise<void> {
    try {
        await sleep(Math.min(ms, WORKER_POLL_MS), undefined, { signal });
    } catch (error) {
        if (!signal.aborted) throw error;
    }
}
