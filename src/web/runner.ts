import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_SETTINGS, type Environment } from '../config/env.js';
import { WorkerBusyError } from '../errors.js';
import { recoverInterruptedCampaigns, validateDeliveryApproval, type RunMode } from '../services/live-campaign.service.js';
import type { Campaign, Store } from '../store/index.js';
import { errorMessage } from '../utils/fs.util.js';
import { HttpError } from './http-error.js';

type Stopping = 'Pausing' | 'Cancelling';

interface ActiveRun {
    campaign: Campaign;
    child: ChildProcess;
    finished: Promise<void>;
    stopping?: Stopping;
}

const CLI_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

export class WebRunner {
    #active: ActiveRun | undefined;
    #closed = false;
    #lastFailure: { id: string; message: string } | undefined;

    constructor(
        private readonly store: Store,
        private readonly settings: () => Environment,
        private readonly onChange: () => void,
    ) {}

    decorate<T extends { id: string; state: string; updatedAt: string }>(campaign: T) {
        const active = this.isActive(campaign.id) ? this.#active : undefined;
        const connecting = active?.campaign.updatedAt === campaign.updatedAt && campaign.state !== 'Running';
        const runStatus = active?.stopping ?? (connecting ? 'Connecting' : undefined);
        return { ...campaign, runActive: Boolean(active), runStatus, runError: this.failureOf(campaign.id) };
    }

    isActive(id: string): boolean {
        return this.#active?.campaign.id === id;
    }

    status(id: string): { active: boolean; error?: string } {
        const error = this.failureOf(id);
        return { active: this.isActive(id), ...(error ? { error } : {}) };
    }

    ensureIdle(): void {
        if (this.#closed) throw new HttpError(503, 'The dashboard is shutting down.');
        if (this.#active) throw new HttpError(409, `Campaign ${this.#active.campaign.id} is sending. Wait for it to finish or pause it first.`);
    }

    launch(id: string, mode: RunMode, approve: unknown): void {
        this.ensureIdle();
        this.checkApproval(id, approve);
        const campaign = this.launchableCampaign(id, mode);
        this.track(campaign, this.spawnWorker(campaign, mode));
    }

    pause(id: string): void {
        const { state } = this.store.getCampaign(id);
        if (state === 'Running' || state === 'Paused' || !this.isActive(id)) this.store.pause(id);
        this.stopWorker(id, 'Pausing');
    }

    cancel(id: string): void {
        this.store.cancel(id);
        this.stopWorker(id, 'Cancelling');
    }

    async close(): Promise<void> {
        this.#closed = true;
        const active = this.#active;
        if (!active) return;
        this.stopWorker(active.campaign.id, 'Pausing');
        await active.finished;
    }

    private failureOf(id: string): string | undefined {
        return this.#lastFailure?.id === id ? this.#lastFailure.message : undefined;
    }

    private checkApproval(id: string, approve: unknown): void {
        try {
            validateDeliveryApproval(this.settings(), id, { live: true, ...(typeof approve === 'string' ? { approve } : {}) });
        } catch (error) {
            throw new HttpError(409, errorMessage(error, 'The live run requires approval.'));
        }
    }

    private launchableCampaign(id: string, mode: RunMode): Campaign {
        const campaign = this.store.getCampaign(id);
        if (campaign.isTest && mode !== 'start') throw new HttpError(409, 'Send a new test from Settings instead.');
        const allowed = mode === 'start' ? campaign.state === 'Ready' : ['Paused', 'Failed'].includes(campaign.state);
        if (!allowed) throw new HttpError(409, `Cannot ${mode} campaign ${id} from state ${campaign.state}.`);
        if (!this.store.campaignSummary(id).queued) throw new HttpError(409, 'The campaign has no queued recipients.');
        return campaign;
    }

    private spawnWorker(campaign: Campaign, mode: RunMode): ChildProcess {
        const command = campaign.isTest ? `${campaign.channel}:test` : `campaign:${mode}`;
        const args = ['--import', 'tsx', CLI_ENTRY, command, campaign.id, '--live', '--approve', campaign.id];
        return spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.workerEnvironment() });
    }

    private workerEnvironment(): NodeJS.ProcessEnv {
        const settings = Object.entries(this.settings()).map(([key, value]) => [key, String(value)]);
        const entries = [...Object.entries(process.env), ...settings];
        return Object.fromEntries(entries.filter(([key]) => !Object.hasOwn(DEFAULT_SETTINGS, key!)));
    }

    private track(campaign: Campaign, child: ChildProcess): void {
        const output = captureErrors(child);
        const finished = new Promise<void>(resolve => {
            child.once('close', code => void this.finish(campaign.id, code, output.message()).finally(resolve));
        });
        if (this.#lastFailure?.id === campaign.id) this.#lastFailure = undefined;
        this.#active = { child, campaign, finished };
        this.onChange();
    }

    private async finish(id: string, code: number | null, message: string): Promise<void> {
        if (code !== 0) {
            await this.recoverQuietly();
            if (!this.#active?.stopping) this.#lastFailure = { id, message: message || 'The campaign worker exited early.' };
        }
        this.#active = undefined;
        this.onChange();
    }

    private async recoverQuietly(): Promise<void> {
        try {
            await recoverInterruptedCampaigns(this.store, this.settings().DATABASE_URL);
        } catch (error) {
            if (!(error instanceof WorkerBusyError)) console.error('Could not recover the interrupted campaign', error);
        }
    }

    private stopWorker(id: string, stopping: Stopping): void {
        const active = this.#active;
        if (active?.campaign.id !== id || active.stopping === stopping) return;
        active.stopping = stopping;
        active.child.kill('SIGINT');
        this.onChange();
    }
}

function captureErrors(child: ChildProcess): { message(): string } {
    let stderr = '';
    let spawnFailed = false;
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
    child.once('error', () => { spawnFailed = true; });
    return { message: () => (spawnFailed ? 'Could not start the campaign worker.' : stripVTControlCharacters(stderr).trim()) };
}
