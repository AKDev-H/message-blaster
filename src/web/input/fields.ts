import { CAMPAIGN_ID } from '../../config/constants.js';
import type { CampaignChannel } from '../../types/index.js';
import { HttpError, type DraftField } from '../http-error.js';
import { MAX_FILE_BYTES } from './body.js';

export function readChannel(value: unknown): CampaignChannel {
    if (value === 'gmail' || value === 'whatsapp') return value;
    throw new HttpError(400, 'Choose Gmail or WhatsApp.', 'channel');
}

export function readChannels(form: FormData): CampaignChannel[] {
    const channels = [...new Set(form.getAll('channel'))].map(readChannel);
    if (!channels.length) throw new HttpError(400, 'Choose at least one channel.', 'channel');
    return channels;
}

export function readCampaignId(value: string): string {
    if (!CAMPAIGN_ID.test(value)) {
        throw new HttpError(400, 'Use 1–64 letters, numbers, hyphens, or underscores. Start with a letter or number.', 'id');
    }
    return value;
}

export function campaignTargets(name: string, channels: readonly CampaignChannel[]): { id: string; channel: CampaignChannel }[] {
    if (channels.length === 1) return [{ id: name, channel: channels[0]! }];
    const targets = channels.map(channel => ({ id: `${name}-${channel}`, channel }));
    if (targets.some(({ id }) => !CAMPAIGN_ID.test(id))) throw new HttpError(400, 'Use 55 characters or fewer when sending to both channels.', 'id');
    return targets;
}

export function readText(form: FormData, name: string, limit: number, field?: DraftField): string {
    const value = form.get(name);
    if (value === null) return '';
    if (typeof value !== 'string' || value.length > limit) throw new HttpError(400, `Use ${limit.toLocaleString('en-US')} characters or fewer.`, field);
    return value;
}

export function readFile(form: FormData, name: string, extension: string, field?: DraftField): File | undefined {
    const value = form.get(name);
    if (value === null || (typeof value !== 'string' && !value.name && !value.size)) return undefined;
    if (typeof value === 'string' || !value.size || !value.name.toLowerCase().endsWith(extension)) {
        throw new HttpError(400, `Choose a ${extension} file.`, field);
    }
    if (value.size > MAX_FILE_BYTES) throw new HttpError(413, 'Each upload can be up to 10 MB.', field);
    return value;
}
