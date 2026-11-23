import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { Environment } from '../config/env.js';
import { recoverInterruptedCampaigns, validateDeliveryApproval, type RunMode } from '../services/live-campaign.service.js';
import type { Campaign, Store } from '../services/message.service.js';
import { HttpError } from './input.js';

interface ActiveRun {
    campaign: Campaign;
    child: ChildProcess;
    finished: Promise<void>;
    stopping?: 'Pausing' | 'Cancelling';
}

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
        const active = this.#active?.campaign.id === campaign.id ? this.#active : undefined;
        const runError = this.#lastFailure?.id === campaign.id ? this.#lastFailure.message : undefined;
        const runStatus = active?.stopping ?? (active?.campaign.updatedAt === campaign.updatedAt && campaign.state !== 'Running'
            ? 'Connecting'
            : undefined);
        return { ...campaign, runActive: Boolean(active), runStatus, runError };
    }

    isActive(id: string) {
        return this.#active?.campaign.id === id;
    }

    launch(id: string, mode: RunMode, approve: unknown) {
        if (this.#closed) throw new HttpError(503, 'The dashboard is shutting down.');
        if (this.#active) throw new HttpError(409, `Campaign ${this.#active.campaign.id} already has an active worker.`);
        try {
            validateDeliveryApproval(this.settings(), id, { live: true, ...(typeof approve === 'string' ? { approve } : {}) });
        } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : 'The live run requires approval.');
        }
        const campaign = this.store.getCampaign(id);
        if (mode === 'start' && campaign.isTest) throw new HttpError(409, 'Send test campaigns with the CLI test command.');
        if (mode === 'start' ? campaign.state !== 'Ready' : !['Paused', 'Failed'].includes(campaign.state)) {
            throw new HttpError(409, `Cannot ${mode} campaign ${id} from state ${campaign.state}.`);
        }
        const { queued } = this.store.campaignSummary(id);
        if (!queued) throw new HttpError(409, 'The campaign has no queued recipients.');

        const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
        const child = spawn(process.execPath, ['--import', 'tsx', entry, `campaign:${mode}`, id, '--live', '--approve', id], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, ...Object.fromEntries(Object.entries(this.settings()).map(([key, value]) => [key, String(value)])) },
        });
        let stderr = '';
        let spawnError = false;
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
        child.once('error', () => { spawnError = true; });
        const finished = new Promise<void>(resolve => {
            child.once('close', code => {
                const message = spawnError ? 'Could not start the campaign worker.' : stripVTControlCharacters(stderr).trim();
                void this.finish(id, code, message).finally(resolve);
            });
        });
        if (this.#lastFailure?.id === id) this.#lastFailure = undefined;
        this.#active = { child, campaign, finished };
        this.onChange();
    }

    pause(id: string) {
        const state = this.store.getCampaign(id).state;
        if (state === 'Running' || state === 'Paused' || !this.isActive(id)) this.store.pause(id);
        this.stopChild(id, 'Pausing');
    }

    cancel(id: string) {
        this.store.cancel(id);
        this.stopChild(id, 'Cancelling');
    }

    async close() {
        this.#closed = true;
        const active = this.#active;
        if (!active) return;
        this.stopChild(active.campaign.id, 'Pausing');
        await active.finished;
    }

    private async finish(id: string, code: number | null, message: string) {
        if (code !== 0) {
            try {
                await recoverInterruptedCampaigns(this.store, this.settings().DATABASE_URL);
            } catch (error) {
                if (!(error instanceof Error) || !error.message.startsWith('Another live campaign')) {
                    console.error('Could not recover the interrupted campaign', error);
                }
            }
            if (!this.#active?.stopping) {
                this.#lastFailure = { id, message: message || 'The campaign worker exited early.' };
            }
        }
        this.#active = undefined;
        this.onChange();
    }

    private stopChild(id: string, stopping: NonNullable<ActiveRun['stopping']>) {
        const active = this.#active;
        if (active?.campaign.id !== id || active.stopping === stopping) return;
        active.stopping = stopping;
        active.child.kill('SIGINT');
        this.onChange();
    }
}
