import { CHANNEL_LABELS, MAX_UPLOAD_BYTES } from '../shared/labels.mjs';
import { number } from '../shared/ui.mjs';
import { campaignNames, sharedVariables } from './variables.mjs';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const SCRIPT_LIMITS = { gmail: 32767, whatsapp: 4096 };
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\{|\}\}/gu;

export function sourceErrors({ channels, editing, name, typing, workbook }, recipientError) {
    const errors = editing ? {} : { id: nameError(name, channels) };
    if (!channels.length) return { ...errors, channel: 'Choose at least one channel.' };
    if (typing) errors.recipients = recipientError();
    else errors.workbook = fileError(workbook, '.xlsx', !editing);
    return errors;
}

export function contentErrors(channels, { subject = '', text = '' }) {
    if (!channels.length) return {};
    return { subject: channels.includes('gmail') ? subjectError(subject) : '', script: scriptError(text, channels) };
}

export function fileError(file, extension, required) {
    if (!file) return required ? `Choose a ${extension ? 'workbook' : 'file'}.` : '';
    if (extension && !file.name.toLowerCase().endsWith(extension)) return `Choose a file ending in ${extension}.`;
    if (!file.size) return 'Choose a file that is not empty.';
    if (file.size > MAX_UPLOAD_BYTES) return 'Choose a file up to 10 MB.';
    return '';
}

function nameError(name, channels) {
    if (!name) return 'Enter a campaign name.';
    if (!NAME_PATTERN.test(name)) return 'Use letters, numbers, hyphens, or underscores. Start with a letter or number.';
    if (campaignNames(name, channels).some(id => id.length > 64)) return 'Use 55 characters or fewer when sending to both channels.';
    return '';
}

function subjectError(subject) {
    return subject.length > 255 ? 'Use 255 characters or fewer.' : templateError(subject, ['gmail']);
}

function scriptError(text, channels) {
    const limit = Math.min(...channels.map(channel => SCRIPT_LIMITS[channel]));
    return text.length > limit ? `Use ${number.format(limit)} characters or fewer.` : templateError(text, channels);
}

function templateError(text, channels) {
    const allowed = sharedVariables(channels);
    for (const [, token] of text.matchAll(PLACEHOLDER)) {
        if (!token) return 'Close each field with }} — type {{ to pick one.';
        if (!allowed.includes(token)) return unavailableMessage(token, channels);
    }
    return '';
}

function unavailableMessage(token, channels) {
    return channels.length > 1 ? `“${token}” isn’t available for both channels.` : `“${token}” isn’t available for ${CHANNEL_LABELS[channels[0]]}.`;
}
