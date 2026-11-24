import { CHANNEL_LABELS } from '../shared/labels.mjs';
import { button, link } from '../shared/ui.mjs';

export function channelButtons(channel, on, { combined }) {
    const { actions } = channel;
    const suffix = combined ? ` ${CHANNEL_LABELS[channel.channel]}` : '';
    const nodes = [];
    if (actions.start || actions.resume) nodes.push(sendButton(channel, on, suffix));
    if (actions.pause) nodes.push(button('Pause', () => on.action('pause', channel.channel), undefined, 'pause'));
    if (actions.retry) nodes.push(button('Retry failed', () => on.action('retry', channel.channel), undefined, 'rotate-ccw'));
    nodes.push(link('Export', on.exportUrl(channel.channel), undefined, 'download'));
    if (actions.cancel) nodes.push(button('Cancel', () => on.action('cancel', channel.channel), 'button quiet-danger small', 'ban'));
    return nodes;
}

export function groupButtons(detail, on) {
    const { campaign, channels } = detail;
    const nodes = [];
    if (detail.draft) nodes.push(button('Edit', () => on.edit(), undefined, 'pencil'));
    if (campaign.sendBoth) nodes.push(sendBothButton(channels, on));
    if (channels.length === 1) nodes.push(...channelButtons(channels[0], on, { combined: false }));
    nodes.push(button('Rename', () => on.action('rename'), 'button ghost small', 'text-cursor-input'));
    if (campaign.deletable) nodes.push(button('Delete', () => on.action('delete'), 'button quiet-danger small', 'trash-2'));
    return nodes;
}

export function buttonSignature(detail) {
    const { campaign, channels, draft } = detail;
    return JSON.stringify([campaign.slug, Boolean(draft), campaign.sendBoth, campaign.deletable, channels.map(channel => channel.actions)]);
}

function sendButton(channel, on, suffix) {
    const starting = channel.actions.start;
    const label = `${starting ? 'Start sending' : 'Resume'}${suffix}`;
    const node = button(label, () => on.action(starting ? 'start' : 'resume', channel.channel), 'button primary small', starting ? 'send' : 'play');
    return blockable(node, channel.actions.sendBlocked);
}

function sendBothButton(channels, on) {
    const node = button('Send both', () => on.action('send'), 'button primary small', 'send');
    return blockable(node, channels.map(channel => channel.actions.sendBlocked).find(Boolean));
}

function blockable(node, reason) {
    node.disabled = Boolean(reason);
    if (reason) node.title = reason;
    return node;
}
