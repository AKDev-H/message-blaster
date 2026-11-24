import { button, campaignPath, link } from '../shared/ui.mjs';
import { isActive } from './status.mjs';

const ACTION_RULES = [
    { when: c => c.hasDraft && !c.active, build: (c, on) => button('Edit', () => on.edit(), undefined, 'pencil') },
    { when: canSend, build: sendButton },
    { when: c => c.latest.runStatus === 'Connecting' || (c.latest.state === 'Running' && !c.latest.runStatus),
        build: (c, on) => button('Pause', () => on.action('pause', c.latest), undefined, 'pause') },
    { when: c => !c.active && c.latest.failed > 0 && !['Draft', 'Ready', 'Cancelled'].includes(c.latest.state),
        build: (c, on) => button('Retry failed', () => on.action('retry', c.latest), undefined, 'rotate-ccw') },
    { when: () => true, build: c => link('Export', `${campaignPath(c.id)}/export`, undefined, 'download') },
    { when: c => !['Completed', 'Cancelled'].includes(c.latest.state) && c.latest.runStatus !== 'Cancelling',
        build: (c, on) => button('Cancel', () => on.action('cancel', c.latest), 'button quiet-danger small', 'ban') },
    { when: c => !c.active, build: (c, on) => button('Delete', () => on.action('delete', c.latest), 'button quiet-danger small', 'trash-2') },
];

export function actionContext(detail, latest, overview) {
    const id = detail.campaign.id;
    return {
        id, latest,
        isTest: detail.campaign.isTest,
        hasDraft: Boolean(detail.draft),
        active: isActive(latest),
        anotherActive: overview.campaigns.some(row => row.id !== id && isActive(row)),
        dryRun: overview.dryRun,
    };
}

export function campaignActions(context, on) {
    return ACTION_RULES.filter(rule => rule.when(context)).map(rule => rule.build(context, on));
}

export function actionSignature(c) {
    const { state, runStatus, queued, failed } = c.latest;
    return JSON.stringify([c.id, c.hasDraft, state, runStatus, c.active, queued > 0, failed > 0, c.anotherActive, c.dryRun]);
}

function canSend(c) {
    const sendable = ['Ready', 'Paused', 'Failed'].includes(c.latest.state) && c.latest.queued > 0;
    return !c.active && sendable && (!c.isTest || c.latest.state !== 'Ready');
}

function sendButton(c, on) {
    const starting = c.latest.state === 'Ready';
    const node = button(starting ? 'Start sending' : 'Resume', () => on.action(starting ? 'start' : 'resume', c.latest),
        'button primary small', starting ? 'send' : 'play');
    node.disabled = c.dryRun || c.anotherActive;
    if (c.dryRun) node.title = 'Sending is turned off in preview mode';
    else if (c.anotherActive) node.title = 'Another campaign is sending';
    return node;
}
