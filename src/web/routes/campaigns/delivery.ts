import type { RunMode } from '../../../services/live-campaign.service.js';
import { CHANNEL_ORDER, type CampaignGroup } from '../../../store/index.js';
import { CAMPAIGN_CHANNEL_LABELS, type CampaignChannel } from '../../../types/index.js';
import { groupVersion, isWorking, loadMembers, type Member } from '../../campaign-view.js';
import { HttpError } from '../../http-error.js';
import { readChannel, readJson, readReview, type JsonBody } from '../../input/index.js';
import type { LaunchStep } from '../../runner.js';
import { senderProblem } from '../../senders.js';
import type { App, Request } from '../route.js';
import { channelRequest, ensureStopped, findGroup, respondChanged } from './context.js';

const STALE = 'This campaign changed since you opened it. Review the latest version, then try again.';

export async function sendChannels(request: Request, app: App): Promise<void> {
    const group = findGroup(app, request.params[0]!);
    const body = await readJson(request.req);
    const members = loadMembers(app, group);
    const steps = readChannels(body.channels, members).map(channel => sendStep(members.find(member => member.channel === channel)!));
    launch(request, app, { group, members, body, steps, action: 'campaign.send' });
    respondChanged(app, request.res, { slug: group.slug, channels: steps.map(step => step.channel) }, 202);
}

export function launchChannel(mode: RunMode) {
    return async (request: Request, app: App): Promise<void> => {
        const { group, member, body } = await channelRequest(request, app);
        const steps = [{ id: member.id, channel: member.channel, mode }];
        launch(request, app, { group, members: loadMembers(app, group), body, steps, action: `campaign.${mode}` });
        respondChanged(app, request.res, { slug: group.slug, channel: member.channel }, 202);
    };
}

export async function pauseChannel(request: Request, app: App): Promise<void> {
    const { group, member, target } = await channelRequest(request, app);
    app.runner.pause(member.id, request.audit, target);
    respondChanged(app, request.res, { slug: group.slug, channel: member.channel });
}

export async function cancelChannel(request: Request, app: App): Promise<void> {
    const { group, member, target } = await channelRequest(request, app);
    app.runner.cancel(member.id, request.audit, target);
    app.store.setPendingChannels(group, group.pendingChannels.filter(channel => channel !== member.channel));
    respondChanged(app, request.res, { slug: group.slug, channel: member.channel });
}

export async function retryChannel(request: Request, app: App): Promise<void> {
    const { group, member, target } = await channelRequest(request, app);
    ensureStopped(app, [member.id]);
    request.audit.mutation('campaign.retry', () => {
        if (!app.store.retryFailed(member.id)) throw new HttpError(409, 'There are no eligible failed recipients to retry.');
    }, target);
    respondChanged(app, request.res, { slug: group.slug, channel: member.channel });
}

export async function reviewChannel(request: Request, app: App): Promise<void> {
    const { group, member, target, body } = await channelRequest(request, app);
    const { recordId, outcome, note } = readReview(body);
    request.audit.mutation('campaign.review', () => app.store.review(recordId, outcome, note, member.id), target);
    respondChanged(app, request.res, { slug: group.slug, channel: member.channel });
}

interface Launch {
    group: CampaignGroup;
    members: readonly Member[];
    body: JsonBody;
    steps: LaunchStep[];
    action: string;
}

function launch({ audit }: Request, app: App, { group, members, body, steps, action }: Launch): void {
    if (body.version !== groupVersion(group, members)) throw new HttpError(409, STALE);
    preflight(app, steps);
    app.runner.launch({ steps, approval: group.slug, approve: body.approve, audit, action, group });
}

function preflight(app: App, steps: readonly LaunchStep[]): void {
    if (app.env.DRY_RUN) throw new HttpError(409, 'Set DRY_RUN=false to enable an explicitly approved live run.');
    const settings = app.settings();
    for (const { channel } of steps) {
        const problem = senderProblem(app, channel, settings);
        if (problem) throw new HttpError(409, `${CAMPAIGN_CHANNEL_LABELS[channel]}: ${problem}`);
    }
}

function readChannels(value: unknown, members: readonly Member[]): CampaignChannel[] {
    if (!Array.isArray(value) || !value.length) throw new HttpError(400, 'Choose at least one channel to send.');
    const requested = new Set(value.map(readChannel));
    for (const channel of requested) {
        if (!members.some(member => member.channel === channel)) throw new HttpError(400, `This campaign does not send with ${CAMPAIGN_CHANNEL_LABELS[channel]}.`);
    }
    return CHANNEL_ORDER.filter(channel => requested.has(channel));
}

function sendStep(member: Member): LaunchStep {
    const label = CAMPAIGN_CHANNEL_LABELS[member.channel];
    if (isWorking(member)) throw new HttpError(409, `${label} is already sending.`);
    if (!member.queued) throw new HttpError(409, `${label} has no queued recipients.`);
    if (member.state === 'Ready') return { id: member.id, channel: member.channel, mode: 'start' };
    if (['Paused', 'Failed'].includes(member.state)) return { id: member.id, channel: member.channel, mode: 'resume' };
    throw new HttpError(409, `${label} is ${member.state.toLowerCase()} and cannot be sent.`);
}
