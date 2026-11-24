import { createHash } from 'node:crypto';
import type { CampaignGroup, CampaignSummary, WebDraftSettings } from '../store/index.js';
import type { CampaignChannel, CampaignState } from '../types/index.js';
import type { App } from './routes/route.js';

type Decorated = ReturnType<App['runner']['decorate']> & CampaignSummary;

export interface ChannelActions {
    edit: boolean;
    start: boolean;
    resume: boolean;
    pause: boolean;
    retry: boolean;
    cancel: boolean;
    sendBlocked?: string;
}

const STATE_PRIORITY: readonly CampaignState[] = ['Running', 'Paused', 'Failed', 'Ready', 'Draft', 'Completed', 'Cancelled'];

export function decorateMembers(app: App, members: readonly CampaignSummary[]): Decorated[] {
    return members.map(member => app.runner.decorate(member));
}

export function isWorking(member: Decorated): boolean {
    return member.runActive || member.state === 'Running' || member.processing > 0;
}

export function groupStatus(members: readonly Decorated[]) {
    const runStatus = members.find(member => member.runStatus)?.runStatus;
    const state = STATE_PRIORITY.find(candidate => members.some(member => member.state === candidate)) ?? 'Draft';
    return {
        state, runStatus,
        runActive: members.some(member => member.runActive),
        runError: members.find(member => member.runError)?.runError,
    };
}

export function groupVersion(group: CampaignGroup, members: readonly CampaignSummary[]): string {
    const parts = members.map(member => `${member.id}:${member.state}:${member.updatedAt}`);
    return createHash('sha256').update([group.slug, ...parts].join('|')).digest('base64url').slice(0, 16);
}

export function scheduledChannels(app: App, group: CampaignGroup, members: readonly Decorated[]): CampaignChannel[] {
    const waiting = members.filter(member => ['Ready', 'Paused', 'Failed'].includes(member.state)).map(member => member.channel);
    return group.pendingChannels.filter(channel => waiting.includes(channel) && app.runner.continuing(group.id));
}

export function pendingChannels(group: CampaignGroup, members: readonly Decorated[]): CampaignChannel[] {
    const waiting = members.filter(member => ['Ready', 'Paused', 'Failed'].includes(member.state) && member.queued > 0).map(member => member.channel);
    return group.pendingChannels.filter(channel => waiting.includes(channel));
}

export function channelActions(app: App, member: Decorated, draft: WebDraftSettings | null, scheduled: boolean): ChannelActions {
    const working = isWorking(member);
    const sendable = !working && member.queued > 0 && !member.isTest;
    const anotherActive = Boolean(app.runner.activeId && app.runner.activeId !== member.id);
    const sendBlocked = app.env.DRY_RUN ? 'Sending is turned off in preview mode' : anotherActive ? 'Another campaign is sending' : undefined;
    return {
        edit: canEdit(member, draft) && !scheduled,
        start: sendable && member.state === 'Ready',
        resume: sendable && ['Paused', 'Failed'].includes(member.state),
        pause: member.runStatus === 'Connecting' || (member.state === 'Running' && !member.runStatus),
        retry: !working && member.failed > 0 && !['Draft', 'Ready', 'Cancelled'].includes(member.state),
        cancel: !['Completed', 'Cancelled'].includes(member.state) && member.runStatus !== 'Cancelling',
        ...(sendBlocked ? { sendBlocked } : {}),
    };
}

export function canEdit(member: Decorated, draft: WebDraftSettings | null): boolean {
    return Boolean(draft) && ['Draft', 'Ready'].includes(member.state) && !isWorking(member);
}
