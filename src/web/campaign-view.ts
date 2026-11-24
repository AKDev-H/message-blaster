import { createHash } from 'node:crypto';
import type { CampaignGroup, CampaignSummary, GroupListing, WebDraftSettings } from '../store/index.js';
import type { CampaignChannel, CampaignState } from '../types/index.js';
import type { App } from './routes/route.js';
import type { RunState } from './runner.js';

export type Member = CampaignSummary & RunState;

export interface ChannelActions {
    start: boolean;
    resume: boolean;
    pause: boolean;
    retry: boolean;
    cancel: boolean;
    sendBlocked?: string;
}

const STATE_PRIORITY: readonly CampaignState[] = ['Running', 'Paused', 'Failed', 'Ready', 'Draft', 'Completed', 'Cancelled'];
const SENDABLE_STATES: readonly CampaignState[] = ['Ready', 'Paused', 'Failed'];

export function loadMembers(app: App, group: CampaignGroup): Member[] {
    return app.store.groupMembers(group).map(member => app.runner.decorate(member));
}

export function isWorking(member: Member): boolean {
    return member.runActive || member.state === 'Running' || member.processing > 0;
}

export function groupVersion(group: CampaignGroup, members: readonly CampaignSummary[]): string {
    const parts = members.map(member => `${member.id}:${member.state}:${member.updatedAt}`);
    return createHash('sha256').update([group.slug, ...parts].join('|')).digest('base64url').slice(0, 16);
}

export function sendPlan(app: App, group: CampaignGroup, members: readonly Member[]) {
    const waiting = new Set(members.filter(member => SENDABLE_STATES.includes(member.state) && member.queued > 0).map(member => member.channel));
    const pending = group.pendingChannels.filter(channel => waiting.has(channel));
    const continuing = app.runner.continuing(group);
    return { pending, continuing, scheduled: continuing ? pending : [] };
}

export function editableDraft(app: App, member: Member, scheduled: readonly CampaignChannel[]): WebDraftSettings | null {
    if (!['Draft', 'Ready'].includes(member.state) || isWorking(member) || scheduled.includes(member.channel)) return null;
    return app.store.getWebDraftSettings(member.id);
}

export function groupListing(app: App, { members, counts, ...listing }: GroupListing, channel?: CampaignChannel) {
    const decorated = members.map(member => app.runner.decorate(member));
    const shown = channel ? decorated.filter(member => member.channel === channel) : decorated;
    return { ...listing, id: listing.slug, ...counts, ...groupStatus(shown) };
}

export function groupDetail(app: App, group: CampaignGroup) {
    const members = loadMembers(app, group);
    const plan = sendPlan(app, group, members);
    const channels = members.map(member => ({
        ...member,
        metrics: app.store.memberMetrics(member.id),
        draft: editableDraft(app, member, plan.scheduled),
        actions: channelActions(app, member),
    }));
    const editable = channels.find(channel => channel.draft);
    return {
        campaign: {
            slug: group.slug, id: group.slug, name: group.name, createdAt: group.createdAt, updatedAt: group.updatedAt,
            channels: members.map(member => member.channel), contactIdentity: group.contactIdentity,
            version: groupVersion(group, members),
            ...groupStatus(members),
            sendPlan: { pending: plan.pending, continuing: plan.continuing },
            sendBoth: members.length > 1 && channels.every(channel => channel.actions.start || channel.actions.resume),
            deletable: !members.some(isWorking),
        },
        metrics: app.store.groupMetrics(group, members),
        channels,
        draft: editable ? { shared: group.shared ?? withoutOverrides(editable.draft!) } : null,
    };
}

function groupStatus(members: readonly Member[]) {
    return {
        state: STATE_PRIORITY.find(state => members.some(member => member.state === state)) ?? 'Draft',
        runStatus: members.find(member => member.runStatus)?.runStatus,
        runActive: members.some(member => member.runActive),
        runError: members.find(member => member.runError)?.runError,
    };
}

function channelActions(app: App, member: Member): ChannelActions {
    const working = isWorking(member);
    const sendable = !working && member.queued > 0 && !member.isTest;
    const sendBlocked = sendBlockReason(app, member);
    return {
        start: sendable && member.state === 'Ready',
        resume: sendable && ['Paused', 'Failed'].includes(member.state),
        pause: member.runStatus === 'Connecting' || (member.state === 'Running' && !member.runStatus),
        retry: !working && member.failed > 0 && !['Draft', 'Ready', 'Cancelled'].includes(member.state),
        cancel: !['Completed', 'Cancelled'].includes(member.state) && member.runStatus !== 'Cancelling',
        ...(sendBlocked ? { sendBlocked } : {}),
    };
}

function sendBlockReason(app: App, member: Member): string | undefined {
    if (app.env.DRY_RUN) return 'Sending is turned off in preview mode';
    if (app.runner.activeId && app.runner.activeId !== member.id) return 'Another campaign is sending';
    return undefined;
}

function withoutOverrides({ overrides: _overrides, ...shared }: WebDraftSettings): Omit<WebDraftSettings, 'overrides'> {
    return shared;
}
