import { CampaignDetails } from './campaigns/details.mjs';
import { CampaignQueue } from './campaigns/queue.mjs';
import { Composer } from './compose/composer.mjs';
import { ConfirmDialog } from './dialogs/confirm.mjs';
import { SettingsDialog } from './settings/settings.mjs';
import { hydrateBrands } from './shared/brands.mjs';
import { hydrateIcons } from './shared/icons.mjs';
import { get, request, setError } from './shared/ui.mjs';
import { FileViewer } from './viewer/viewer.mjs';

const RECONNECT_CHECK_MS = 5000;

hydrateIcons();
hydrateBrands();

const state = { campaigns: null, dryRun: true, revision: null, streamUpdates: 0 };

const viewer = new FileViewer();
const settings = new SettingsDialog();
const queue = new CampaignQueue(openDetails);
const details = new CampaignDetails({
    edit: detail => composer.open(detail),
    action: (action, campaign, recordId) => confirmation.open(action, campaign, recordId),
    viewAttachment: name => viewer.open(name),
    close: focusClosedCampaign,
});
const composer = new Composer(async id => {
    await loadOverview();
    openDetails(id);
}, viewer);
const confirmation = new ConfirmDialog(async action => {
    if (action === 'delete') details.close();
    await loadOverview();
    if (details.selected) await details.reload();
});

wireDialogs();
wireToolbar();
followLiveUpdates();
loadOverview();

function openDetails(id) {
    queue.render(state.campaigns, id);
    details.open(id);
}

/** After the panel closes, focus goes back to the campaign's row in the table. */
function focusClosedCampaign(id) {
    queue.render(state.campaigns, '');
    if (id) get('campaign-rows').querySelector(`[data-campaign="${CSS.escape(id)}"]`)?.focus();
}

/** Applies a campaign list from the server. The open panel reloads only if its campaign changed. */
function applySnapshot(snapshot) {
    const previous = new Map((state.campaigns ?? []).map(campaign => [campaign.id, JSON.stringify(campaign)]));
    const revisionChanged = state.revision !== (snapshot.revision ?? null);
    Object.assign(state, { campaigns: snapshot.campaigns, dryRun: snapshot.dryRun, revision: snapshot.revision ?? null });
    get('mode-indicator').hidden = !state.dryRun;
    composer.setAiAvailable(Boolean(snapshot.ai));
    queue.render(state.campaigns, details.selected);
    details.update(state, campaign => revisionChanged || previous.get(campaign.id) !== JSON.stringify(campaign));
}

/** Fetches the list directly. Ignored if a live update arrived meanwhile, since that one is newer. */
async function loadOverview() {
    const streamUpdates = state.streamUpdates;
    try {
        const snapshot = await request('/api/campaigns');
        if (streamUpdates !== state.streamUpdates) return;
        applySnapshot(snapshot);
        setError('page-error', '');
    } catch (error) {
        if (streamUpdates === state.streamUpdates) setError('page-error', error);
    }
}

/** Live updates come over Server-Sent Events. While disconnected, the list is polled instead. */
function followLiveUpdates() {
    const events = new EventSource('/api/events');
    events.addEventListener('open', () => setConnection('live', 'Live'));
    events.addEventListener('message', event => onLiveUpdate(event));
    events.addEventListener('error', () => setConnection('offline', 'Reconnecting…'));
    window.setInterval(() => {
        if (events.readyState !== EventSource.OPEN) loadOverview();
    }, RECONNECT_CHECK_MS);
}

function onLiveUpdate(event) {
    state.streamUpdates += 1;
    applySnapshot(JSON.parse(event.data));
    setError('page-error', '');
}

function setConnection(mode, message) {
    const target = get('connection');
    if (target.dataset.mode === mode) return;
    target.dataset.mode = mode;
    target.lastElementChild.textContent = message;
}

function wireDialogs() {
    for (const dialog of document.querySelectorAll('dialog')) {
        for (const close of dialog.querySelectorAll('[data-close]')) close.addEventListener('click', () => dialog.close());
    }
}

function wireToolbar() {
    get('create-campaign').addEventListener('click', () => composer.open());
    get('open-settings').addEventListener('click', () => settings.open());
    get('empty-action').addEventListener('click', () => (state.campaigns?.length ? queue.clearFilters() : composer.open()));
    wireTemplateMenu(get('template-menu'));
}

/** The template download menu closes on a choice, a click outside, or Escape. */
function wireTemplateMenu(menu) {
    menu.addEventListener('click', event => {
        if (event.target.closest('a')) menu.open = false;
    });
    document.addEventListener('click', event => {
        if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !menu.open) return;
        menu.open = false;
        menu.querySelector('summary').focus();
    });
}
