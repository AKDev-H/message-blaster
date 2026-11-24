import type { ServerResponse } from 'node:http';
import { exportCampaignWorkbook } from '../../services/campaign/export.js';
import type { RunMode } from '../../services/live-campaign.service.js';
import type { NewCampaign } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { HttpError } from '../http-error.js';
import { json, noContent, sendWorkbook } from '../http.js';
import {
    campaignTargets, previewDraft, readCampaignId, readCampaignQuery, readChannels, readDraft, readForm, readJson, readReview, type Draft,
} from '../input/index.js';
import type { App, Request, Route } from './route.js';

const PAGE_SIZE = 25;
const CAMPAIGN_PAGE_SIZE = 10;
export const CAMPAIGN_PATH = /^\/api\/campaigns\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?$/u;
const campaign = (action?: string) => new RegExp(`^/api/campaigns/([A-Za-z0-9_-]+)${action ? `/${action}` : ''}$`, 'u');

export const campaignRoutes: Route[] = [
    { method: 'GET', path: '/api/events', handle: ({ res }, app) => app.updates.subscribe(res) },
    { method: 'GET', path: '/api/campaigns', handle: listCampaigns },
    { method: 'POST', path: '/api/campaigns', handle: createCampaigns },
    { method: 'GET', path: campaign(), handle: showCampaign },
    { method: 'GET', path: campaign('export'), handle: exportResults },
    { method: 'PUT', path: campaign('draft'), handle: editDraft },
    { method: 'DELETE', path: campaign(), handle: deleteCampaign },
    { method: 'POST', path: campaign('start'), handle: (request, app) => launch(request, app, 'start') },
    { method: 'POST', path: campaign('resume'), handle: (request, app) => launch(request, app, 'resume') },
    { method: 'POST', path: campaign('pause'), handle: pause },
    { method: 'POST', path: campaign('cancel'), handle: cancel },
    { method: 'POST', path: campaign('retry'), handle: retryFailed },
    { method: 'POST', path: campaign('review'), handle: review },
];

function listCampaigns({ res, query }: Request, app: App): void {
    const result = app.store.listCampaignPage(readCampaignQuery(query, CAMPAIGN_PAGE_SIZE));
    const campaigns = result.campaigns.map(campaign => app.runner.decorate(campaign));
    json(res, 200, { ...(app.snapshot() as object), ...result, campaigns });
}

async function createCampaigns({ req, res }: Request, app: App): Promise<void> {
    const form = await readForm(req);
    const name = readCampaignId(String(form.get('id') ?? ''));
    const targets = campaignTargets(name, readChannels(form));
    const draft = await readDraft(form);
    app.store.importCampaigns(await prepareTargets(app, targets, draft, targets.length > 1 ? name : undefined));
    app.updates.changed();
    json(res, 201, { id: targets[0]!.id, ids: targets.map(({ id }) => id) });
}

async function prepareTargets(app: App, targets: { id: string; channel: CampaignChannel }[], draft: Draft, group?: string) {
    const campaigns: NewCampaign[] = [];
    for (const { id, channel } of targets) {
        campaigns.push({ id, channel, draft, rows: await previewDraft(app.store, app.settings(), id, channel, draft, group) });
    }
    return campaigns;
}

function showCampaign({ res, params, query }: Request, app: App): void {
    const id = readCampaignId(params[0]!);
    const summary = app.runner.decorate(app.store.campaignSummary(id));
    const editable = ['Draft', 'Ready'].includes(summary.state) && !summary.runActive;
    const draft = editable ? app.store.getWebDraftSettings(id) : null;
    json(res, 200, { campaign: summary, ...app.store.listMessagePage(id, pageNumber(query), PAGE_SIZE), draft });
}

async function exportResults({ res, params }: Request, app: App): Promise<void> {
    const id = readCampaignId(params[0]!);
    sendWorkbook(res, await exportCampaignWorkbook(app.store, id), `${id}-results.xlsx`);
}

async function editDraft({ req, res, params }: Request, app: App): Promise<void> {
    const id = readCampaignId(params[0]!);
    ensureNotSending(app, id);
    const { channel, workbook } = editableDraft(app, id);
    const draft = await readDraft(await readForm(req), workbook);
    const rows = await previewDraft(app.store, app.settings(), id, channel, draft);
    ensureNotSending(app, id);
    app.store.replaceWebDraft(id, rows, draft);
    done(app, res, id);
}

function deleteCampaign({ res, params }: Request, app: App): void {
    const id = readCampaignId(params[0]!);
    ensureNotSending(app, id);
    app.store.deleteCampaign(id);
    app.updates.changed();
    noContent(res);
}

async function launch(request: Request, app: App, mode: RunMode): Promise<void> {
    const { id, body } = await actionInput(request);
    app.runner.launch(id, mode, body.approve);
    json(request.res, 202, { id });
}

async function pause(request: Request, app: App): Promise<void> {
    const { id } = await actionInput(request);
    app.runner.pause(id);
    done(app, request.res, id);
}

async function cancel(request: Request, app: App): Promise<void> {
    const { id } = await actionInput(request);
    app.runner.cancel(id);
    done(app, request.res, id);
}

async function retryFailed(request: Request, app: App): Promise<void> {
    const { id } = await actionInput(request);
    ensureNotSending(app, id);
    if (!app.store.retryFailed(id)) throw new HttpError(409, 'There are no eligible failed recipients to retry.');
    done(app, request.res, id);
}

async function review(request: Request, app: App): Promise<void> {
    const { id, body } = await actionInput(request);
    const { recordId, outcome, note } = readReview(body);
    app.store.review(recordId, outcome, note, id);
    done(app, request.res, id);
}

async function actionInput({ req, params }: Request) {
    const id = readCampaignId(params[0]!);
    return { id, body: await readJson(req) };
}

function editableDraft(app: App, id: string) {
    const { accountId, state, channel } = app.store.getCampaign(id);
    if (accountId || !['Draft', 'Ready'].includes(state)) throw new HttpError(409, 'Only campaigns that have never started can be edited.');
    const previous = app.store.getWebDraft(id);
    if (!previous) throw new HttpError(409, 'Only campaigns imported in the dashboard have editable drafts.');
    return { channel, workbook: previous.workbook };
}

function ensureNotSending(app: App, id: string): void {
    if (app.runner.isActive(id)) throw new HttpError(409, 'Wait for the campaign worker to finish stopping.');
}

function done(app: App, res: ServerResponse, id: string): void {
    app.updates.changed();
    json(res, 200, { id });
}

function pageNumber(query: URLSearchParams): number {
    const requested = Number(query.get('page') ?? '1');
    return Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
}
