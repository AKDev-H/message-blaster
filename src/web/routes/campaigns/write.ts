import { CHANNEL_ORDER, type CampaignGroup } from '../../../store/index.js';
import { editableDraft, loadMembers, sendPlan } from '../../campaign-view.js';
import { HttpError } from '../../http-error.js';
import { noContent } from '../../http.js';
import {
    campaignTargets, channelDrafts, prepareCampaigns, readCampaignId, readChannels, readDraft, readForm, readJson, sharedContent, type CampaignTarget,
} from '../../input/index.js';
import type { App, Request } from '../route.js';
import { ensureStopped, findGroup, respondChanged } from './context.js';

const NAME_LIMIT = 100;

export async function createGroup({ req, res, audit }: Request, app: App): Promise<void> {
    const form = await readForm(req);
    const slug = readCampaignId(String(form.get('id') ?? ''));
    const targets = campaignTargets(slug, readChannels(form));
    const combined = targets.length > 1;
    const shared = await readDraft(form);
    const drafts = channelDrafts(form, shared, targets.map(target => target.channel), combined);
    const campaigns = await prepareCampaigns(app.store, app.settings(), targets, drafts, combined ? slug : undefined);
    audit.mutation('campaign.create', () => app.store.createCampaignGroup({ slug, name: slug, shared: sharedContent(shared), campaigns }), slug);
    respondChanged(app, res, { slug, id: targets[0]!.id, ids: targets.map(target => target.id) }, 201);
}

export async function editGroupDraft({ req, res, params, audit }: Request, app: App): Promise<void> {
    const group = findGroup(app, params[0]!);
    const { targets, combined } = editableTargets(app, group);
    const form = await readForm(req);
    const shared = await readDraft(form, app.store.getWebDraft(targets[0]!.id)!.workbook);
    const drafts = channelDrafts(form, shared, targets.map(target => target.channel), combined);
    const campaigns = await prepareCampaigns(app.store, app.settings(), targets, drafts, combined ? group.slug : undefined);
    ensureStopped(app, targets.map(target => target.id));
    const channels = targets.map(target => target.channel);
    audit.mutation('campaign.edit', () => app.store.replaceGroupDraft(group, campaigns, sharedContent(shared)), `${group.slug}/${channels.join('+')}`);
    respondChanged(app, res, { slug: group.slug, channels });
}

export async function renameGroup({ req, res, params, audit }: Request, app: App): Promise<void> {
    const group = findGroup(app, params[0]!);
    const name = readGroupName((await readJson(req)).name);
    audit.mutation('campaign.rename', () => app.store.renameGroup(group.slug, name), group.slug);
    respondChanged(app, res, { slug: group.slug, name });
}

export function deleteGroup({ res, params, audit }: Request, app: App): void {
    const group = findGroup(app, params[0]!);
    ensureStopped(app, app.store.groupMembers(group).map(member => member.id));
    audit.mutation('campaign.delete', () => app.store.deleteGroup(group.slug), group.slug);
    app.runner.forget(group);
    app.updates.changed();
    noContent(res);
}

function editableTargets(app: App, group: CampaignGroup): { targets: CampaignTarget[]; combined: boolean } {
    const members = loadMembers(app, group);
    const { scheduled } = sendPlan(app, group, members);
    const editable = members.filter(member => editableDraft(app, member, scheduled));
    if (!editable.length) throw new HttpError(409, 'Only channels that have never started can be edited.');
    const targets = CHANNEL_ORDER.flatMap(channel => editable.filter(member => member.channel === channel)).map(({ id, channel }) => ({ id, channel }));
    return { targets, combined: members.length > 1 };
}

function readGroupName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > NAME_LIMIT || hasControlCharacters(name)) throw new HttpError(400, `Use 1–${NAME_LIMIT} characters on one line.`);
    return name;
}

function hasControlCharacters(text: string): boolean {
    return [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
