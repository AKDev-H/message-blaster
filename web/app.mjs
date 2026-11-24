import { createDetails, createQueue } from './campaigns.mjs';
import { createComposer } from './compose.mjs';
import { createConfirm } from './confirm.mjs';
import { hydrateBrands } from './brands.mjs';
import { hydrateIcons } from './icons.mjs';
import { createSettings } from './settings.mjs';
import { get, request, setError } from './ui.mjs';
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

function applySnapshot(snapshot) {
    const previous = new Map((state.campaigns ?? []).map(campaign => [campaign.id, JSON.stringify(campaign)]));
    const revisionChanged = state.revision !== (snapshot.revision ?? null);
    Object.assign(state, { campaigns: snapshot.campaigns, dryRun: snapshot.dryRun, revision: snapshot.revision ?? null });

    get('mode-indicator').hidden = !state.dryRun;
    composer.setAiAvailable(Boolean(snapshot.ai));
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
