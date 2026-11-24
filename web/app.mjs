import { CampaignDetails } from './campaigns/details.mjs';
import { CampaignQueue } from './campaigns/queue.mjs';
import { Composer } from './compose/composer.mjs';
import { ConfirmDialog } from './dialogs/confirm.mjs';
import { currentRoute, followLink, navigate, onRouteChange } from './router.mjs';
import { SettingsDialog } from './settings/settings.mjs';
import { hydrateBrands } from './shared/brands.mjs';
import { hydrateIcons } from './shared/icons.mjs';
import { campaignPage, get, request, setError, whileBusy } from './shared/ui.mjs';
import { FileViewer } from './viewer/viewer.mjs';

const RECONNECT_CHECK_MS = 5000;
// The server pings every 15s, so 40s of silence means the stream is dead.
const STALE_STREAM_MS = 40_000;
const LIST_TITLE = 'Campaigns | Message Blaster';

hydrateIcons();
hydrateBrands();

const MAINTENANCE = 503;
const state = { dryRun: true, active: [], view: '' };

const viewer = new FileViewer();
const settings = new SettingsDialog();
const queue = new CampaignQueue({ onLoad: applyOverview, onError: showLoadError });
const details = new CampaignDetails({
    edit: detail => composer.open(detail),
    action: (action, channel, recordId) => openConfirmation(action, channel, recordId),
    viewAttachment: name => viewer.open(name),
    close: closeDetails,
    missing: () => navigate('/'),
});
const composer = new Composer(async slug => {
    if (state.view === 'campaign' && details.selected === slug) await details.reload();
    else navigate(campaignPage(slug), { fromList: state.view === 'list' });
}, viewer);
const confirmation = new ConfirmDialog(async action => {
    if (action === 'delete') return closeDetails();
    await details.reload();
});

wireDialogs();
wireToolbar();
wireAccount();
followLiveUpdates();
onRouteChange(showRoute);
showRoute();

function showRoute() {
    const route = currentRoute();
    const listView = route.view === 'list';
    get('queue').hidden = !listView;
    get('page-title').closest('.overview').hidden = !listView;
    get('nav-campaigns').toggleAttribute('aria-current', listView);
    if (listView) {
        details.close();
        document.title = LIST_TITLE;
        const changed = queue.applySearch(route.search);
        if (changed || state.view !== 'list') queue.load();
        state.view = 'list';
        return;
    }
    state.view = 'campaign';
    details.open(route.slug);
    window.scrollTo({ top: 0 });
}

function closeDetails() {
    if (window.history.state?.fromList) window.history.back();
    else navigate('/');
}

function openConfirmation(action, channel, recordId) {
    const current = details.current;
    if (!current) return;
    const combined = current.channels.length > 1;
    confirmation.open(action, {
        slug: current.slug, name: current.name, channel: channel ?? current.channels[0], recordId, combined,
        channels: current.channels, version: () => details.current?.version ?? current.version,
    });
}

function applyOverview(snapshot) {
    Object.assign(state, { dryRun: snapshot.dryRun, active: snapshot.active ?? [] });
    get('mode-indicator').hidden = !state.dryRun;
    composer.setAiAvailable(Boolean(snapshot.ai));
    setError('page-error', '');
}

function showLoadError(error) {
    if (error.status === MAINTENANCE) return window.location.reload();
    setError('page-error', error);
}

function followLiveUpdates() {
    let events;
    let lastSeen = Date.now();
    const seen = () => { lastSeen = Date.now(); };
    const isStale = () => events.readyState === EventSource.CLOSED || Date.now() - lastSeen > STALE_STREAM_MS;
    const connect = () => {
        events?.close();
        events = new EventSource('/api/events');
        seen();
        events.addEventListener('open', () => { seen(); setConnection('live', 'Live'); });
        events.addEventListener('message', event => { seen(); onLiveUpdate(event); });
        events.addEventListener('ping', seen);
        events.addEventListener('error', () => setConnection('offline', 'Reconnecting…'));
    };
    // After sleep the socket can look OPEN while it is dead, so a wake always re-fetches and replaces a silent stream.
    const catchUp = () => {
        if (document.visibilityState !== 'visible') return;
        if (isStale()) connect();
        refreshView();
    };
    connect();
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('online', catchUp);
    window.setInterval(() => {
        if (isStale()) catchUp();
        else if (events.readyState !== EventSource.OPEN) refreshView();
    }, RECONNECT_CHECK_MS);
}

function onLiveUpdate(event) {
    applyOverview(JSON.parse(event.data));
    refreshView();
}

function refreshView() {
    if (state.view === 'campaign') details.reload();
    else if (state.view === 'list') queue.refresh();
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
    for (const home of [get('nav-campaigns'), document.querySelector('.brand')]) home.addEventListener('click', event => followLink(event, '/'));
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
