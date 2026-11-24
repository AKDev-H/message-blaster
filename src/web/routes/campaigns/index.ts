import type { Route } from '../route.js';
import { channelPath, groupPath } from './context.js';
import { cancelChannel, launchChannel, pauseChannel, retryChannel, reviewChannel, sendChannels } from './delivery.js';
import { exportChannel, listGroups, showChannel, showGroup } from './read.js';
import { createGroup, deleteGroup, editGroupDraft, renameGroup } from './write.js';

export { groupExists } from './context.js';

export const campaignRoutes: Route[] = [
    { method: 'GET', path: '/api/events', handle: ({ res, sessionActive }, app) => app.updates.subscribe(res, sessionActive) },
    { method: 'GET', path: '/api/campaign-groups', handle: listGroups },
    { method: 'POST', path: '/api/campaign-groups', handle: createGroup },
    { method: 'GET', path: groupPath(), handle: showGroup },
    { method: 'PATCH', path: groupPath(), handle: renameGroup },
    { method: 'DELETE', path: groupPath(), handle: deleteGroup },
    { method: 'PUT', path: groupPath('/draft'), handle: editGroupDraft },
    { method: 'POST', path: groupPath('/send'), handle: sendChannels },
    { method: 'GET', path: channelPath(), handle: showChannel },
    { method: 'GET', path: channelPath('/export'), handle: exportChannel },
    { method: 'POST', path: channelPath('/start'), handle: launchChannel('start') },
    { method: 'POST', path: channelPath('/resume'), handle: launchChannel('resume') },
    { method: 'POST', path: channelPath('/pause'), handle: pauseChannel },
    { method: 'POST', path: channelPath('/cancel'), handle: cancelChannel },
    { method: 'POST', path: channelPath('/retry'), handle: retryChannel },
    { method: 'POST', path: channelPath('/review'), handle: reviewChannel },
];
