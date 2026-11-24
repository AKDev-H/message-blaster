import { channelMark } from '../shared/brands.mjs';
import { CHANNEL_LABELS, channelList, plural } from '../shared/labels.mjs';
import { button, element, get, number } from '../shared/ui.mjs';
import { badge, statusOf } from './status.mjs';

export const OVERVIEW = 'overview';

const METRICS = [
    ['peopleSent', 'People sent to', true],
    ['completed', 'Successful sends', true],
    ['failed', 'Failed', true],
    ['unknown', 'Needs review', false],
    ['queued', 'Queued', true],
    ['processing', 'Sending', false],
    ['delivered', 'Delivered', false],
    ['read', 'Read', false],
    ['skipped', 'Skipped', false],
];

export function describeCampaign({ campaign, channels, metrics }) {
    const label = channelList(campaign.channels);
    if (channels.length === 1) return `${label}, ${plural(channels[0].total, 'recipient', 'recipients')}`;
    if (metrics.people === null) return `${label}, ${plural(metrics.total, 'recipient', 'recipients')} across channels`;
    return `${label}, ${plural(metrics.people, 'person', 'people')}`;
}

export const ALL_RECIPIENTS = 'peopleSent';

export function metricTiles(metrics, channels, filter = null) {
    return METRICS.filter(([key, , always]) => always || metrics[key] || filter?.active === key)
        .map(([key, label]) => filter ? filterTab(key, label, metrics[key], filter) : metricTile(key, label, metrics[key], channels));
}

export function sendPlanNotice({ pending, continuing }) {
    if (!pending.length) return '';
    const names = pending.map(channel => CHANNEL_LABELS[channel]).join(' and ');
    return continuing
        ? `${names} will start automatically when the current channel finishes.`
        : `${names} hasn’t started yet. Review it, then send it when you’re ready.`;
}

export function viewTab(view, onSelect) {
    const tab = element('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.detailChannel = view;
    if (view === OVERVIEW) tab.append(element('span', '', 'Overview'));
    else tab.append(channelMark(view, 14), element('span', '', CHANNEL_LABELS[view]));
    tab.addEventListener('click', () => onSelect(view));
    return tab;
}

export function channelCard(channel, onOpen) {
    const card = element('article', 'channel-card');
    card.dataset.channelCard = channel.channel;
    const { metrics } = channel;
    const facts = [
        `${number.format(metrics.completed)} of ${plural(metrics.total - metrics.skipped, 'recipient', 'recipients')} sent`,
        metrics.failed ? `${number.format(metrics.failed)} failed` : '',
        metrics.unknown ? `${number.format(metrics.unknown)} to review` : '',
    ].filter(Boolean).join(' · ');
    card.append(channelHeading(channel, 'channel-card-head'), element('p', 'muted', facts),
        button('View recipients', () => onOpen(channel.channel), 'button secondary small', 'chevron-right'));
    return card;
}

export function channelHeading(channel, className) {
    const heading = element('header', className);
    heading.append(channelMark(channel.channel), element('strong', '', CHANNEL_LABELS[channel.channel]), badge(statusOf(channel)));
    return heading;
}

export function skeletonRecipientRows(count = 6) {
    return Array.from({ length: Math.min(8, Math.max(3, count)) }, () => {
        const row = element('tr', 'skeleton-row');
        row.setAttribute('aria-hidden', 'true');
        for (const size of ['wide', 'wide', 'pill', 'tiny']) {
            const cell = element('td');
            cell.append(element('span', size === 'pill' ? 'skeleton skeleton-pill' : `skeleton skeleton-line ${size}`));
            row.append(cell);
        }
        return row;
    });
}

export function paginate(current, total) {
    get('page-number').textContent = `${number.format(current)} / ${number.format(Math.max(1, total))}`;
    get('previous-page').disabled = current <= 1;
    get('next-page').disabled = current >= total;
}

function metricTile(key, label, value, channels) {
    const node = element('div', `detail-count ${key}`);
    node.dataset.detailMetric = key;
    if (value !== null) {
        node.append(element('strong', '', number.format(value ?? 0)), element('span', '', label));
        return node;
    }
    const perChannel = channels.map(channel => `${CHANNEL_LABELS[channel.channel]}: ${number.format(channel.metrics.completed)}`).join(' · ');
    node.title = perChannel;
    node.append(element('strong', '', '—'), element('span', '', label), element('span', 'muted', `(${perChannel})`));
    return node;
}

function filterTab(key, label, value, { active, onSelect }) {
    const tab = element('button', `detail-count ${key}`);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.detailMetric = key;
    const selected = key === active;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.append(element('strong', '', number.format(value ?? 0)), element('span', '', label));
    tab.addEventListener('click', () => onSelect(key));
    return tab;
}
