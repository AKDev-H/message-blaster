import { exportCampaignWorkbook } from '../../services/campaign/export.js';
import type { RunMode } from '../../services/live-campaign.service.js';
import { CHANNEL_ORDER, type CampaignGroup, type CampaignSummary, type DraftReplacement, type NewCampaign } from '../../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../../types/index.js';
import {
    canEdit, channelActions, decorateMembers, groupStatus, groupVersion, isWorking, pendingChannels, scheduledChannels,
} from '../campaign-view.js';
import { HttpError } from '../http-error.js';
import { json, noContent, sendWorkbook } from '../http.js';
import {
    campaignTargets, channelDraft, parseWorkbook, prepareChannel, readCampaignId, readCampaignQuery, readChannel, readChannels, readDraft,
    readForm, readJson, readReview, sharedContent, type JsonBody,
} from '../input/index.js';
import type { SequenceStep } from '../runner.js';
import { senderProblem } from '../senders.js';
import type { App, Request, Route } from './route.js';

const PAGE_SIZE = 25;
const LIST_PAGE_SIZE = 10;
const SLUG = '([A-Za-z0-9_-]+)';
const CHANNEL = '(gmail|whatsapp)';
const path = (suffix = '') => new RegExp(`^/api/campaign-groups/${SLUG}${suffix}$`, 'u');
const STALE = 'This campaign changed since you opened it. Review the latest version, then try again.';

type Member = ReturnType<typeof decorateMembers>[number];

export const campaignGroupRoutes: Route[] = [
    { method: 'GET', path: '/api/campaign-groups', handle: listGroups },
    { method: 'POST', path: '/api/campaign-groups', handle: createGroup },
    { method: 'POST', path: '/api/campaigns', handle: createGroup },
    { method: 'GET', path: path(), handle: showGroup },
    { method: 'PATCH', path: path(), handle: renameGroup },
    { method: 'DELETE', path: path(), handle: deleteGroup },
    { method: 'PUT', path: path('/draft'), handle: editGroupDraft },
    { method: 'POST', path: path('/send'), handle: sendChannels },
    { method: 'GET', path: path(`/${CHANNEL}`), handle: showChannel },
    { method: 'GET', path: path(`/${CHANNEL}/export`), handle: exportChannel },
    { method: 'POST', path: path(`/${CHANNEL}/start`), handle: (request, app) => launchChannel(request, app, 'start') },
    { method: 'POST', path: path(`/${CHANNEL}/resume`), handle: (request, app) => launchChannel(request, app, 'resume') },
    { method: 'POST', path: path(`/${CHANNEL}/pause`), handle: pauseChannel },
    { method: 'POST', path: path(`/${CHANNEL}/cancel`), handle: cancelChannel },
    { method: 'POST', path: path(`/${CHANNEL}/retry`), handle: retryChannel },
    { method: 'POST', path: path(`/${CHANNEL}/review`), handle: reviewChannel },
];

export function groupExists(app: App, slug: string): boolean {
    try {
        app.store.campaignGroup(readCampaignId(slug));
        return true;
    } catch {
        return false;
    }
}

function listGroups({ res, query }: Request, app: App): void {
    const filters = readCampaignQuery(query, LIST_PAGE_SIZE);
    const result = app.store.listGroupPage(filters);
    const campaigns = result.groups.map(({ members, counts, ...group }) => {
        const decorated = decorateMembers(app, members);
        const shown = filters.channel ? decorated.filter(member => member.channel === filters.channel) : decorated;
        return { ...group, id: group.slug, ...counts, ...groupStatus(shown), isTest: false };
    });
    const { groups: _groups, ...page } = result;
    json(res, 200, { ...(app.snapshot() as object), ...page, campaigns });
}

async function createGroup({ req, res, audit }: Request, app: App): Promise<void> {
    const form = await readForm(req);
    const slug = readCampaignId(String(form.get('id') ?? ''));
    const channels = CHANNEL_ORDER.filter(channel => readChannels(form).includes(channel));
    const targets = campaignTargets(slug, channels);
    const shared = await readDraft(form);
    const drafts = targets.map(({ channel }) => (targets.length > 1 ? channelDraft(form, shared, channel) : { ...shared, overrides: [] }));
    const parsed = await parseWorkbook(app.settings(), channels, drafts);
    const campaigns: NewCampaign[] = [];
    for (const [index, { id, channel }] of targets.entries()) {
        const draft = drafts[index]!;
        campaigns.push({ id, channel, draft, rows: await prepareChannel(app.store, app.settings(), id, channel, draft, parsed, targets.length > 1 ? slug : undefined) });
    }
    audit.mutation('campaign.create', () => app.store.createCampaignGroup({ slug, name: slug, shared: sharedContent(shared), campaigns }), slug);
    app.updates.changed();
    json(res, 201, { slug, id: targets[0]!.id, ids: targets.map(({ id }) => id) });
}

function showGroup({ res, params }: Request, app: App): void {
    const group = findGroup(app, params[0]!);
    const members = decorateMembers(app, app.store.groupMembers(group));
    const scheduled = scheduledChannels(app, group, members);
    const channels = members.map(member => {
        const draft = app.store.getWebDraftSettings(member.id);
        const editable = canEdit(member, draft) && !scheduled.includes(member.channel);
        return {
            ...member, metrics: app.store.memberMetrics(member.id), draft: editable ? draft : null,
            actions: channelActions(app, member, draft, scheduled.includes(member.channel)),
        };
    });
    const editable = channels.some(channel => channel.draft);
    const pending = pendingChannels(group, members);
    json(res, 200, {
        campaign: {
            slug: group.slug, id: group.slug, name: group.name, createdAt: group.createdAt, updatedAt: group.updatedAt,
            channels: members.map(member => member.channel), contactIdentity: group.contactIdentity, version: groupVersion(group, members),
            ...groupStatus(members),
            sendPlan: { pending, continuing: app.runner.continuing(group.id) },
            sendBoth: members.length > 1 && channels.every(channel => channel.actions.start || channel.actions.resume),
            deletable: !members.some(isWorking),
        },
        metrics: app.store.groupMetrics(group, members),
        channels,
        draft: editable ? { shared: group.shared ?? sharedFrom(channels[0]!.draft ?? app.store.getWebDraftSettings(members[0]!.id)) } : null,
    });
}

function showChannel({ res, params, query }: Request, app: App): void {
    const group = findGroup(app, params[0]!);
    const member = app.runner.decorate(app.store.groupMember(group, readChannel(params[1])));
    json(res, 200, { campaign: member, metrics: app.store.memberMetrics(member.id), ...app.store.listMessagePage(member.id, pageNumber(query), PAGE_SIZE) });
}

async function exportChannel({ res, params, audit }: Request, app: App): Promise<void> {
    const group = findGroup(app, params[0]!);
    const channel = readChannel(params[1]);
    const member = app.store.groupMember(group, channel);
    const workbook = await exportCampaignWorkbook(app.store, member.id);
    audit.record('campaign.export', 'success', target(group, channel));
    sendWorkbook(res, workbook, `${group.slug}-${channel}-results.xlsx`);
}

async function renameGroup({ req, res, params, audit }: Request, app: App): Promise<void> {
    const group = findGroup(app, params[0]!);
    const name = readGroupName((await readJson(req)).name);
    audit.mutation('campaign.rename', () => app.store.renameGroup(group.slug, name), group.slug);
    app.updates.changed();
    json(res, 200, { slug: group.slug, name });
}

function deleteGroup({ res, params, audit }: Request, app: App): void {
    const group = findGroup(app, params[0]!);
    for (const member of app.store.groupMembers(group)) ensureNotSending(app, member.id);
    audit.mutation('campaign.delete', () => app.store.deleteGroup(group.slug), group.slug);
    app.runner.forgetSequence(group.id);
    app.updates.changed();
    noContent(res);
}

async function editGroupDraft({ req, res, params, audit }: Request, app: App): Promise<void> {
    const group = findGroup(app, params[0]!);
    const form = await readForm(req);
    const members = editableMembers(app, group);
    const previous = app.store.getWebDraft(members[0]!.id)!;
    const shared = await readDraft(form, previous.workbook);
    const combined = app.store.groupMembers(group).length > 1;
    const drafts = members.map(member => (combined ? channelDraft(form, shared, member.channel) : { ...shared, overrides: [] }));
    const parsed = await parseWorkbook(app.settings(), members.map(member => member.channel), drafts);
    const replacements: DraftReplacement[] = [];
    for (const [index, member] of members.entries()) {
        const draft = drafts[index]!;
        replacements.push({ id: member.id, draft, rows: await prepareChannel(app.store, app.settings(), member.id, member.channel, draft, parsed, combined ? group.slug : undefined) });
    }
    for (const member of members) ensureNotSending(app, member.id);
    audit.mutation('campaign.edit', () => app.store.replaceGroupDraft(group, replacements, sharedContent(shared)),
        `${group.slug}/${members.map(member => member.channel).join('+')}`);
    app.updates.changed();
    json(res, 200, { slug: group.slug, channels: members.map(member => member.channel) });
}

async function sendChannels({ req, res, params, audit }: Request, app: App): Promise<void> {
    const group = findGroup(app, params[0]!);
    const body = await readJson(req);
    const members = decorateMembers(app, app.store.groupMembers(group));
    checkVersion(group, members, body);
    const requested = readRequestedChannels(body.channels, members);
    const steps = requested.map(channel => sendStep(members.find(member => member.channel === channel)!));
    preflight(app, steps);
    app.runner.launchSequence(group, steps, body.approve, audit);
    app.updates.changed();
    json(res, 202, { slug: group.slug, channels: requested });
}

async function launchChannel(request: Request, app: App, mode: RunMode): Promise<void> {
    const { group, member, body } = await channelInput(request, app);
    checkVersion(group, decorateMembers(app, app.store.groupMembers(group)), body);
    app.runner.launch(member.id, mode, body.approve, request.audit, `campaign.${mode}`, target(group, member.channel), group.slug);
    app.store.setPendingChannels(group, group.pendingChannels.filter(channel => channel !== member.channel));
    app.updates.changed();
    json(request.res, 202, { slug: group.slug, channel: member.channel });
}

async function pauseChannel(request: Request, app: App): Promise<void> {
    const { group, member } = await channelInput(request, app);
    app.runner.pause(member.id, request.audit, target(group, member.channel));
    done(app, request, group, member);
}

async function cancelChannel(request: Request, app: App): Promise<void> {
    const { group, member } = await channelInput(request, app);
    app.runner.cancel(member.id, request.audit, target(group, member.channel));
    if (!app.runner.isActive(member.id)) app.runner.forgetSequence(group.id);
    app.store.setPendingChannels(group, group.pendingChannels.filter(channel => channel !== member.channel));
    done(app, request, group, member);
}

async function retryChannel(request: Request, app: App): Promise<void> {
    const { group, member } = await channelInput(request, app);
    ensureNotSending(app, member.id);
    request.audit.mutation('campaign.retry', () => {
        if (!app.store.retryFailed(member.id)) throw new HttpError(409, 'There are no eligible failed recipients to retry.');
    }, target(group, member.channel));
    done(app, request, group, member);
}

async function reviewChannel(request: Request, app: App): Promise<void> {
    const { group, member, body } = await channelInput(request, app);
    const { recordId, outcome, note } = readReview(body);
    request.audit.mutation('campaign.review', () => app.store.review(recordId, outcome, note, member.id), target(group, member.channel));
    done(app, request, group, member);
}

function findGroup(app: App, slug: string): CampaignGroup {
    return app.store.campaignGroup(readCampaignId(slug));
}

async function channelInput(request: Request, app: App) {
    const group = findGroup(app, request.params[0]!);
    const member = app.store.groupMember(group, readChannel(request.params[1]));
    return { group, member, body: await readJson(request.req) };
}

function editableMembers(app: App, group: CampaignGroup): Member[] {
    const members = decorateMembers(app, app.store.groupMembers(group));
    const scheduled = scheduledChannels(app, group, members);
    const editable = members.filter(member => canEdit(member, app.store.getWebDraftSettings(member.id)) && !scheduled.includes(member.channel));
    if (!editable.length) throw new HttpError(409, 'Only channels that have never started can be edited.');
    return editable;
}

function readRequestedChannels(value: unknown, members: readonly Member[]): CampaignChannel[] {
    if (!Array.isArray(value) || !value.length) throw new HttpError(400, 'Choose at least one channel to send.');
    const requested = new Set(value.map(readChannel));
    for (const channel of requested) {
        if (!members.some(member => member.channel === channel)) throw new HttpError(400, `This campaign does not send with ${CAMPAIGN_CHANNEL_LABELS[channel]}.`);
    }
    return CHANNEL_ORDER.filter(channel => requested.has(channel));
}

function sendStep(member: Member): SequenceStep {
    const label = CAMPAIGN_CHANNEL_LABELS[member.channel];
    if (isWorking(member)) throw new HttpError(409, `${label} is already sending.`);
    if (!member.queued) throw new HttpError(409, `${label} has no queued recipients.`);
    if (member.state === 'Ready') return { id: member.id, channel: member.channel, mode: 'start' };
    if (['Paused', 'Failed'].includes(member.state)) return { id: member.id, channel: member.channel, mode: 'resume' };
    throw new HttpError(409, `${label} is ${member.state.toLowerCase()} and cannot be sent.`);
}

function preflight(app: App, steps: readonly SequenceStep[]): void {
    if (app.env.DRY_RUN) throw new HttpError(409, 'Set DRY_RUN=false to enable an explicitly approved live run.');
    const settings = app.settings();
    for (const step of steps) {
        const problem = senderProblem(app, step.channel, settings);
        if (problem) throw new HttpError(409, `${CAMPAIGN_CHANNEL_LABELS[step.channel]}: ${problem}`);
    }
}

function checkVersion(group: CampaignGroup, members: readonly CampaignSummary[], body: JsonBody): void {
    if (body.version !== groupVersion(group, members)) throw new HttpError(409, STALE);
}

function readGroupName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';
    const singleLine = [...name].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
    if (!name || name.length > 100 || !singleLine) throw new HttpError(400, 'Use 1–100 characters on one line.', 'id');
    return name;
}

function sharedFrom(draft: ReturnType<App['store']['getWebDraftSettings']>) {
    if (!draft) return null;
    const { overrides: _overrides, ...shared } = draft;
    return shared;
}

function ensureNotSending(app: App, id: string): void {
    if (app.runner.isActive(id)) throw new HttpError(409, 'Wait for the campaign worker to finish stopping.');
}

function target(group: CampaignGroup, channel: CampaignChannel): string {
    return `${group.slug}/${channel}`;
}

function done(app: App, { res }: Request, group: CampaignGroup, member: CampaignSummary): void {
    app.updates.changed();
    json(res, 200, { slug: group.slug, channel: member.channel });
}

function pageNumber(query: URLSearchParams): number {
    const requested = Number(query.get('page') ?? '1');
    return Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
}
