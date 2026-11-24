import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_SETTINGS, type Environment } from '../config/env.js';
import { WorkerBusyError } from '../errors.js';
import { recoverInterruptedCampaigns, validateDeliveryApproval, type RunMode } from '../services/live-campaign.service.js';
import type { Campaign, CampaignGroup, Store } from '../store/index.js';
import type { CampaignChannel } from '../types/index.js';
import { errorMessage } from '../utils/fs.util.js';
import type { RequestAudit } from './auth/audit.js';
import { HttpError } from './http-error.js';

type Stopping = 'Pausing' | 'Cancelling';

interface ActiveRun {
    campaign: Campaign;
    child: ChildProcess;
    finished: Promise<void>;
    stopping?: Stopping;
}

export interface SequenceStep {
    id: string;
    channel: CampaignChannel;
    mode: RunMode;
}

// A "Send both" run: the next channel starts only after the current one completes in this
// process. Anything else (pause, cancel, failure, restart) leaves the rest pending in the
// database until someone explicitly resumes it.
interface Sequence {
    group: CampaignGroup;
    current: string;
    remaining: SequenceStep[];
    audit: RequestAudit;
}

export type SpawnWorker = (campaign: Campaign, mode: RunMode, env: NodeJS.ProcessEnv) => ChildProcess;

const CLI_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

export class WebRunner {
    #active: ActiveRun | undefined;
    #closed = false;
    #lastFailure: { id: string; message: string } | undefined;
    #sequence: Sequence | undefined;

    constructor(
        private readonly store: Store,
        private readonly settings: () => Environment,
        private readonly onChange: () => void,
        private readonly spawnWorker: SpawnWorker = spawnCliWorker,
    ) {}

    decorate<T extends { id: string; state: string; updatedAt: string }>(campaign: T) {
        const active = this.isActive(campaign.id) ? this.#active : undefined;
        const connecting = active?.campaign.updatedAt === campaign.updatedAt && campaign.state !== 'Running';
        const runStatus = active?.stopping ?? (connecting ? 'Connecting' : undefined);
        return { ...campaign, runActive: Boolean(active), runStatus, runError: this.failureOf(campaign.id) };
    }

    get activeId(): string | undefined {
        return this.#active?.campaign.id;
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

    launch(id: string, mode: RunMode, approve: unknown, audit: RequestAudit, action: string, target = id, approval = id): void {
        this.ensureIdle();
        this.checkApproval(approval, approve);
        const campaign = this.launchableCampaign(id, mode);
        audit.record(action, 'accepted', target);
        this.start(campaign, mode, audit, target);
    }

    // Validates every step before the first one starts, then runs them one after another.
    launchSequence(group: CampaignGroup, steps: readonly SequenceStep[], approve: unknown, audit: RequestAudit): void {
        this.ensureIdle();
        this.checkApproval(group.slug, approve);
        const campaigns = steps.map(step => this.launchableCampaign(step.id, step.mode));
        const [first, ...remaining] = steps;
        if (!first) throw new HttpError(409, 'Choose at least one channel to send.');
        audit.record('campaign.send', 'accepted', `${group.slug}/${steps.map(step => step.channel).join('+')}`);
        this.store.setPendingChannels(group, remaining.map(step => step.channel));
        this.#sequence = remaining.length ? { group, current: first.id, remaining, audit } : undefined;
        this.start(campaigns[0]!, first.mode, audit, `${group.slug}/${first.channel}`);
    }

    continuing(groupId: number): boolean {
        return this.#sequence?.group.id === groupId;
    }

    pause(id: string, audit: RequestAudit, target = id): void {
        const { state } = this.store.getCampaign(id);
        if (state === 'Running' || state === 'Paused' || !this.isActive(id)) {
            audit.mutation('campaign.pause', () => this.store.pause(id), target);
        } else {
            audit.record('campaign.pause', 'accepted', target);
        }
        this.stopWorker(id, 'Pausing');
    }

    cancel(id: string, audit: RequestAudit, target = id): void {
        audit.mutation('campaign.cancel', () => this.store.cancel(id), target);
        this.stopWorker(id, 'Cancelling');
    }

    forgetSequence(groupId: number): void {
        if (this.#sequence?.group.id === groupId) this.#sequence = undefined;
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

    private checkApproval(expected: string, approve: unknown): void {
        try {
            validateDeliveryApproval(this.settings(), expected, { live: true, ...(typeof approve === 'string' ? { approve } : {}) });
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

    private start(campaign: Campaign, mode: RunMode, audit: RequestAudit, target: string): void {
        this.track(campaign, this.spawnWorker(campaign, mode, this.workerEnvironment()), audit, target);
    }

    private workerEnvironment(): NodeJS.ProcessEnv {
        const settings = Object.entries(this.settings()).map(([key, value]) => [key, String(value)]);
        const entries = [...Object.entries(process.env), ...settings];
        const env = Object.fromEntries(entries.filter(([key]) => !Object.hasOwn(DEFAULT_SETTINGS, key!)));
        delete env.GOOGLE_CLIENT_ID;
        delete env.GOOGLE_CLIENT_SECRET;
        env.MESSAGE_BLASTER_WORKER = '1';
        return env;
    }

    private track(campaign: Campaign, child: ChildProcess, audit: RequestAudit, target: string): void {
        const output = captureErrors(child);
        const finished = new Promise<void>(resolve => {
            child.once('close', code => {
                try {
                    audit.record('campaign.worker_exit', code === 0 ? 'success' : 'failed', target, 'worker');
                } catch {
                    console.error('Could not record the campaign worker exit');
                }
                void this.finish(campaign.id, code, output.message()).finally(resolve);
            });
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
        this.continueSequence(id, code);
        this.onChange();
    }

    private continueSequence(finishedId: string, code: number | null): void {
        const sequence = this.#sequence;
        if (!sequence || sequence.current !== finishedId) return;
        this.#sequence = undefined;
        if (code !== 0 || this.#closed || this.store.getCampaign(finishedId).state !== 'Completed') return;
        const [next, ...remaining] = sequence.remaining;
        if (!next) return;
        try {
            if (this.settings().DRY_RUN) throw new HttpError(409, 'Live sending was turned off before the next channel started.');
            const campaign = this.launchableCampaign(next.id, next.mode);
            this.store.setPendingChannels(sequence.group, remaining.map(step => step.channel));
            if (remaining.length) this.#sequence = { ...sequence, current: next.id, remaining };
            this.start(campaign, next.mode, sequence.audit, `${sequence.group.slug}/${next.channel}`);
        } catch (error) {
            this.#lastFailure = { id: next.id, message: errorMessage(error, 'The next channel could not start.') };
        }
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

function spawnCliWorker(campaign: Campaign, mode: RunMode, env: NodeJS.ProcessEnv): ChildProcess {
    const command = campaign.isTest ? `${campaign.channel}:test` : `campaign:${mode}`;
    const args = ['--import', 'tsx', CLI_ENTRY, command, campaign.id, '--live', '--approve', campaign.id];
    return spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
}

function captureErrors(child: ChildProcess): { message(): string } {
    let stderr = '';
    let spawnFailed = false;
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
    child.once('error', () => { spawnFailed = true; });
    return { message: () => (spawnFailed ? 'Could not start the campaign worker.' : stripVTControlCharacters(stderr).trim()) };
}
