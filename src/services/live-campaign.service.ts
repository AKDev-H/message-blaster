import type { Logger } from 'pino';
import type { Environment } from '../config/env.js';
import { ConflictError } from '../errors.js';
import type { Campaign, Store } from '../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignState, type MessageTransport } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { runCampaign } from '../workers/campaign.worker.js';
import { wait, watchShutdown } from './shutdown.js';
import { acquireWorkerLock } from './worker-lock.js';
import type { WhatsAppService } from './whatsapp/service.js';

export { recoverInterruptedCampaigns } from './worker-lock.js';
export { wait } from './shutdown.js';

export type RunMode = 'start' | 'resume';

export interface DeliveryOptions {
    live?: boolean;
    approve?: string;
}

export interface RunResult {
    attempts: number;
    connectionError: Error | undefined;
}

interface Delivery {
    store: Store;
    env: Environment;
    campaign: Campaign;
    mode: RunMode;
}

interface Session {
    socket: WhatsAppService;
    logger: Logger;
    signal: AbortSignal;
}

const ALLOWED_STATES: Record<RunMode, readonly CampaignState[]> = {
    start: ['Ready'],
    resume: ['Paused', 'Failed'],
};

export function validateDeliveryApproval(env: Environment, id: string, options: DeliveryOptions): void {
    if (!options.live) return;
    if (env.DRY_RUN) throw new Error('Set DRY_RUN=false to enable an explicitly approved live run.');
    if (options.approve !== id) throw new Error(`Explicit approval required. Use --live --approve ${id} after reviewing the campaign.`);
}

export async function runLiveCampaign(store: Store, env: Environment, id: string, mode: RunMode, options: DeliveryOptions,
    reportRecovery: (count: number) => void): Promise<RunResult | undefined> {
    if (!options.live) throw new Error('A live campaign requires --live.');
    validateDeliveryApproval(env, id, options);
    using _lock = await acquireWorkerLock(env.DATABASE_URL);
    const delivery: Delivery = { store, env, mode, campaign: campaignToRun(store, id, mode, reportRecovery) };
    return delivery.campaign.channel === 'gmail' ? await sendWithGmail(delivery) : await sendWithWhatsApp(delivery);
}

export async function withWhatsAppSession<T>(store: Store, env: Environment, allowPairing: boolean,
    useSession: (session: Session) => Promise<T>): Promise<T> {
    using shutdown = watchShutdown();
    const { WhatsAppService } = await import('./whatsapp/service.js');
    const logger = createLogger(env);
    const socket = new WhatsAppService(env.AUTH_DIR, logger, (id, stage) => store.receipt(id, stage), allowPairing);
    try {
        await socket.connect(shutdown.signal);
        return await useSession({ socket, logger, signal: shutdown.signal });
    } finally {
        await socket.close();
    }
}

function campaignToRun(store: Store, id: string, mode: RunMode, reportRecovery: (count: number) => void): Campaign {
    const recovered = store.recover();
    if (recovered) reportRecovery(recovered);
    const campaign = store.getCampaign(id);
    if (!ALLOWED_STATES[mode].includes(campaign.state)) throw new ConflictError(`Cannot ${mode} campaign ${id} from state ${campaign.state}.`);
    return campaign;
}

async function sendWithGmail(delivery: Delivery): Promise<RunResult | undefined> {
    using shutdown = watchShutdown();
    const { GmailService } = await import('./gmail.service.js');
    const smtp = new GmailService(delivery.env);
    const accountId = checkSenderAccount(delivery, smtp.accountId);
    await smtp.connect();
    if (shutdown.signal.aborted) return undefined;
    const attempts = await deliver(delivery, smtp, accountId, createLogger(delivery.env), shutdown.signal);
    return { attempts, connectionError: undefined };
}

function sendWithWhatsApp(delivery: Delivery): Promise<RunResult | undefined> {
    return withWhatsAppSession(delivery.store, delivery.env, false, async ({ socket, logger, signal }) => {
        if (signal.aborted) return undefined;
        const attempts = await deliver(delivery, socket, checkSenderAccount(delivery, socket.accountId), logger, signal);
        await wait(delivery.env.RECEIPT_WAIT_MS, signal);
        return { attempts, connectionError: signal.aborted ? undefined : socket.connectionError };
    });
}

function checkSenderAccount({ store, campaign }: Delivery, accountId: string | undefined): string {
    const label = CAMPAIGN_CHANNEL_LABELS[campaign.channel];
    if (!accountId) throw new Error(`The ${label} account identity is unavailable.`);
    if (campaign.accountId !== null && campaign.accountId !== accountId) throw new ConflictError(`Campaign is bound to a different ${label} account.`);
    if (!campaign.isTest && !store.hasConfirmedTest(accountId)) {
        throw new Error(`Send and confirm a test in Settings › ${label} before starting a campaign (or run ${campaign.channel}:test and ${campaign.channel}:confirm-test).`);
    }
    return accountId;
}

async function deliver({ store, env, campaign, mode }: Delivery, transport: MessageTransport, accountId: string,
    logger: Logger, signal: AbortSignal): Promise<number> {
    store.bindAccount(campaign.id, accountId);
    store[mode](campaign.id);
    try {
        return await runCampaign(store, campaign.id, env, transport, logger, signal);
    } catch (error) {
        store.setCampaignFailed(campaign.id);
        throw error;
    }
}
