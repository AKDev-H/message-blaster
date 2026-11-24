import { CampaignDetails } from './campaigns/details.mjs';
import { CampaignQueue } from './campaigns/queue.mjs';
import { Composer } from './compose/composer.mjs';
import { ConfirmDialog } from './dialogs/confirm.mjs';
import { SettingsDialog } from './settings/settings.mjs';
import { hydrateBrands } from './shared/brands.mjs';
import { hydrateIcons } from './shared/icons.mjs';
import { get, request, setError, whileBusy } from './shared/ui.mjs';
import { FileViewer } from './viewer/viewer.mjs';

const RECONNECT_CHECK_MS = 5000;

hydrateIcons();
hydrateBrands();

const MAINTENANCE = 503;
const state = { dryRun: true, active: [] };

const viewer = new FileViewer();
const settings = new SettingsDialog();
const queue = new CampaignQueue({ onOpen: openDetails, onLoad: applyOverview, onError: showLoadError });
const details = new CampaignDetails({
    edit: detail => composer.open(detail),
    action: (action, campaign, recordId) => confirmation.open(action, campaign, recordId),
    viewAttachment: name => viewer.open(name),
    close: focusClosedCampaign,
});
const composer = new Composer(async id => {
    await queue.refresh();
    openDetails(id);
}, viewer);
const confirmation = new ConfirmDialog(async action => {
    if (action === 'delete') details.close();
    await queue.refresh();
    if (details.selected) await details.reload();
});

wireDialogs();
wireToolbar();
wireAccount();
followLiveUpdates();
queue.load();

function openDetails(id) {
    queue.select(id);
    details.open(id);
}

function focusClosedCampaign(id) {
    queue.select('');
    if (id) get('campaign-rows').querySelector(`[data-campaign="${CSS.escape(id)}"]`)?.focus();
}

function applyOverview(snapshot) {
    Object.assign(state, { dryRun: snapshot.dryRun, active: snapshot.active ?? [] });
    get('mode-indicator').hidden = !state.dryRun;
    composer.setAiAvailable(Boolean(snapshot.ai));
    details.update(state);
    setError('page-error', '');
}

function showLoadError(error) {
    if (error.status === MAINTENANCE) return window.location.reload();
    setError('page-error', error);
}

function followLiveUpdates() {
    const events = new EventSource('/api/events');
    events.addEventListener('open', () => setConnection('live', 'Live'));
    events.addEventListener('message', event => onLiveUpdate(event));
    events.addEventListener('error', () => setConnection('offline', 'Reconnecting…'));
    window.setInterval(() => {
        if (events.readyState !== EventSource.OPEN) queue.refresh();
    }, RECONNECT_CHECK_MS);
}

function onLiveUpdate(event) {
    applyOverview(JSON.parse(event.data));
    queue.refresh();
    details.reload();
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
    get('empty-action').addEventListener('click', () => (queue.hasCampaigns ? queue.clearFilters() : composer.open()));
    wireTemplateMenu(get('template-menu'));
}

function wireAccount() {
    const control = get('sign-out');
    request('/api/session').then(({ user }) => {
        get('open-audit').hidden = user.role !== 'admin';
    }).catch(showLoadError);
    control.addEventListener('click', () => void whileBusy(control, async () => {
        try {
            await request('/auth/logout', { method: 'POST' });
            window.location.replace('/login');
        } catch (error) {
            showLoadError(error);
        }
    }));
}

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
