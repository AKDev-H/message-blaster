import { number } from './ui.mjs';

export const CHANNEL_LABELS = { gmail: 'Gmail', whatsapp: 'WhatsApp' };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function plural(count, one, many) {
    return `${number.format(count)} ${count === 1 ? one : many}`;
}

export function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${number.format(Math.ceil(bytes / 1024))} KB`;
    return `${number.format(Math.round(bytes / 1024 ** 2 * 10) / 10)} MB`;
}

export function fileKind(name) {
    return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4) : 'FILE';
}

export function extensionOf(name) {
    return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

export function channelList(channels) {
    return channels.map(channel => CHANNEL_LABELS[channel]).join(' + ');
}
