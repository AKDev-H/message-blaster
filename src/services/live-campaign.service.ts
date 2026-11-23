import { realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Environment } from '../config/env.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignState, type MessageTransport } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { runCampaign } from '../workers/campaign.worker.js';
import type { Store } from './message.service.js';
import type { WhatsAppService } from './whatsapp.service.js';

export type RunMode = 'start' | 'resume';

export interface DeliveryOptions {
    live?: boolean;
    approve?: string;
}

const allowedStates: Record<RunMode, readonly CampaignState[]> = {
    start: ['Ready'],
    resume: ['Paused', 'Failed'],
};

export function validateDeliveryApproval(env: Environment, id: string, options: DeliveryOptions): void {
    if (!options.live) return;
    if (env.DRY_RUN) throw new Error('Set DRY_RUN=false to enable an explicitly approved live run.');
    if (options.approve !== id) {
        throw new Error(`Explicit approval required. Use --live --approve ${id} after reviewing the campaign.`);
    }
}

export async function recoverInterruptedCampaigns(store: Store, databasePath: string): Promise<number> {
    using _lock = await acquireWorkerLock(databasePath);
    return store.recover();
}

export async function runLiveCampaign(
    store: Store,
    env: Environment,
    id: string,
    mode: RunMode,
    options: DeliveryOptions,
    reportRecovery: (count: number) => void,
) {
    if (!options.live) throw new Error('A live campaign requires --live.');
    validateDeliveryApproval(env, id, options);

    using _lock = await acquireWorkerLock(env.DATABASE_URL);
    const recovered = store.recover();
    if (recovered) reportRecovery(recovered);
    const campaign = store.getCampaign(id);
    if (!allowedStates[mode].includes(campaign.state)) {
        throw new Error(`Cannot ${mode} campaign ${id} from state ${campaign.state}.`);
    }

    function checkAccount(accountId: string | undefined) {
        const label = CAMPAIGN_CHANNEL_LABELS[campaign.channel];
        if (!accountId) throw new Error(`The ${label} account identity is unavailable.`);
        if (campaign.accountId !== null && campaign.accountId !== accountId) {
            throw new Error(`Campaign is bound to a different ${label} account.`);
        }
        if (!campaign.isTest && !store.hasConfirmedTest(accountId)) {
            throw new Error(`Run ${campaign.channel}:test and ${campaign.channel}:confirm-test for this sender account before starting a campaign.`);
        }
        return accountId;
    }

    async function deliver(transport: MessageTransport, accountId: string, logger: Logger, signal: AbortSignal) {
        store.bindAccount(id, accountId);
        store[mode](id);
        try {
            return await runCampaign(store, id, env, transport, logger, signal);
        } catch (error) {
            store.setCampaignFailed(id);
            throw error;
        }
    }

    if (campaign.channel === 'gmail') {
        using shutdown = watchShutdown();
        const { GmailService } = await import('./gmail.service.js');
        const smtp = new GmailService(env);
        const accountId = checkAccount(smtp.accountId);
        await smtp.connect();
        if (shutdown.signal.aborted) return;
        const attempts = await deliver(smtp, accountId, createLogger(env), shutdown.signal);
        return { attempts, connectionError: undefined };
    }

    return await withWhatsAppSession(store, env, false, async ({ socket, logger, signal }) => {
        if (signal.aborted) return;
        const attempts = await deliver(socket, checkAccount(socket.accountId), logger, signal);
        await wait(env.RECEIPT_WAIT_MS, signal);
        return { attempts, connectionError: signal.aborted ? undefined : socket.connectionError };
    });
}

interface Session {
    socket: WhatsAppService;
    logger: Logger;
    signal: AbortSignal;
}

export async function withWhatsAppSession<T>(
    store: Store,
    env: Environment,
    allowPairing: boolean,
    useSession: (session: Session) => Promise<T>,
): Promise<T> {
    using shutdown = watchShutdown();
    const { WhatsAppService } = await import('./whatsapp.service.js');
    const logger = createLogger(env);
    const socket = new WhatsAppService(env.AUTH_DIR, logger, (id, stage) => store.receipt(id, stage), allowPairing);
    try {
        await socket.connect(shutdown.signal);
        return await useSession({ socket, logger, signal: shutdown.signal });
    } finally {
        await socket.close();
    }
}

async function acquireWorkerLock(databasePath: string): Promise<DatabaseSync> {
    const dbPath = await realpath(databasePath);
    const lock = new DatabaseSync(`${dbPath}.worker-lock.sqlite`, { timeout: 0 });
    try {
        lock.exec('BEGIN IMMEDIATE');
        return lock;
    } catch (error) {
        lock.close();
        if (error instanceof Error && /locked|busy/i.test(error.message)) {
            throw new Error('Another live campaign worker already owns this database.', { cause: error });
        }
        throw error;
    }
}

function watchShutdown() {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return {
        signal: controller.signal,
        [Symbol.dispose]() {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
        },
    };
}

export async function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (!ms || signal.aborted) return;
    try {
        await sleep(ms, undefined, { signal });
    } catch (error) {
        if (!signal.aborted) throw error;
    }
}
