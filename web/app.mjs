import { countKeys, createDetails, createQueue } from './campaigns.mjs';
import { createComposer } from './compose.mjs';
import { createConfirm } from './confirm.mjs';
import { hydrateBrands } from './brands.mjs';
import { hydrateIcons } from './icons.mjs';
import { createSettings } from './settings.mjs';
import { get, number, request, setError } from './ui.mjs';
import { createViewer } from './viewer.mjs';

hydrateIcons();
hydrateBrands();

const state = { campaigns: null, dryRun: true, revision: null, streamUpdates: 0 };

const queue = createQueue(openDetails);
const details = createDetails({
    onEdit: detail => composer.open(detail),
    onAction: (action, campaign, recordId) => confirmation.open(action, campaign, recordId),
    onViewAttachment: name => viewer.open(name),
    onClose: id => {
        queue.render(state.campaigns, '');
        if (id) get('campaign-rows').querySelector(`[data-campaign="${CSS.escape(id)}"]`)?.focus();
    },
});
const viewer = createViewer();
const settings = createSettings();
const composer = createComposer(async id => {
    await loadOverview();
    openDetails(id);
}, viewer);
const confirmation = createConfirm(async action => {
    if (action === 'delete') details.close();
    await loadOverview();
    if (details.selected) await details.reload();
});

function openDetails(id) {
    queue.render(state.campaigns, id);
    details.open(id);
}

function setConnection(mode, message) {
    const target = get('connection');
    if (target.dataset.mode === mode) return;
    target.dataset.mode = mode;
    target.lastElementChild.textContent = message;
}

function setMetric(key, value) {
    const target = get(`metric-${key}`);
    const text = number.format(value);
    if (target.textContent === text) return;
    target.textContent = text;
    // Restart the highlight animation whenever a counter moves.
    target.classList.remove('changed');
    void target.offsetWidth;
    target.classList.add('changed');
}

function applySnapshot(snapshot) {
    const previous = new Map((state.campaigns ?? []).map(campaign => [campaign.id, JSON.stringify(campaign)]));
    const revisionChanged = state.revision !== (snapshot.revision ?? null);
    Object.assign(state, { campaigns: snapshot.campaigns, dryRun: snapshot.dryRun, revision: snapshot.revision ?? null });

    get('mode-indicator').hidden = !state.dryRun;
    composer.setAiAvailable(Boolean(snapshot.ai));
    const totals = Object.fromEntries(countKeys.map(key =>
        [key, state.campaigns.reduce((sum, campaign) => sum + (campaign[key] ?? 0), 0)]));
    for (const key of ['queued', 'processing', 'completed', 'failed']) setMetric(key, totals[key]);
    const caption = get('metric-failed-caption');
    caption.textContent = totals.unknown ? `${number.format(totals.unknown)} need review` : '';
    caption.hidden = !totals.unknown;

    queue.render(state.campaigns, details.selected);
    details.update(state, campaign => revisionChanged || previous.get(campaign.id) !== JSON.stringify(campaign));
}

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

for (const dialog of document.querySelectorAll('dialog')) {
    for (const close of dialog.querySelectorAll('[data-close]')) close.addEventListener('click', () => dialog.close());
}
get('create-campaign').addEventListener('click', () => composer.open());
get('open-settings').addEventListener('click', () => settings.open());

// The template menu closes after a choice, on Escape, or when clicking elsewhere.
const templateMenu = get('template-menu');
templateMenu.addEventListener('click', event => {
    if (event.target.closest('a')) templateMenu.open = false;
});
document.addEventListener('click', event => {
    if (templateMenu.open && !templateMenu.contains(event.target)) templateMenu.open = false;
});
templateMenu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !templateMenu.open) return;
    templateMenu.open = false;
    templateMenu.querySelector('summary').focus();
});
get('empty-action').addEventListener('click', () => {
    if (state.campaigns?.length) queue.clearFilters();
    else composer.open();
});

const events = new EventSource('/api/events');
events.addEventListener('open', () => setConnection('live', 'Live'));
events.addEventListener('message', event => {
    state.streamUpdates += 1;
    applySnapshot(JSON.parse(event.data));
    setError('page-error', '');
});
events.addEventListener('error', () => setConnection('offline', 'Reconnecting…'));
window.setInterval(() => {
    if (events.readyState !== EventSource.OPEN) loadOverview();
}, 5000);
loadOverview();
