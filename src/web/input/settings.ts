import { isSupportedCountry } from 'libphonenumber-js';
import type { DraftRequest } from '../../services/ai.service.js';
import type { EditableSettings } from '../../services/settings.service.js';
import type { CampaignChannel } from '../../types/index.js';
import { normalizeEmail } from '../../utils/email.util.js';
import { HttpError } from '../http-error.js';
import type { JsonBody } from './body.js';
import { readChannel } from './fields.js';

export function readGmailSettings(body: JsonBody, hasPassword: boolean): Partial<EditableSettings> {
    const address = readGmailAddress(body.user);
    const pass = typeof body.password === 'string' ? body.password.replaceAll(/\s/gu, '') : '';
    if (!pass && !hasPassword) throw new HttpError(400, 'Enter the 16-character App Password.', 'gmailPassword');
    if (pass && !/^[a-z0-9]{16}$/iu.test(pass)) throw new HttpError(400, 'An App Password has 16 letters and numbers.', 'gmailPassword');
    return { GMAIL_USER: address, ...(pass ? { GMAIL_APP_PASSWORD: pass } : {}) };
}

export function readSendingSettings(body: JsonBody): Partial<EditableSettings> {
    const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
    if (!isSupportedCountry(country)) throw new HttpError(400, 'Choose a country.', 'country');
    const seconds = body.delaySeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) throw new HttpError(400, 'Use 0–3,600 seconds.', 'delay');
    return { DEFAULT_COUNTRY: country, MESSAGE_DELAY_MS: Math.round(seconds * 1_000) };
}

export function readTestRecipient(body: JsonBody, channel: CampaignChannel): string {
    const recipient = typeof body.recipient === 'string' ? body.recipient.trim() : '';
    if (recipient && recipient.length <= 320) return recipient;
    const message = channel === 'gmail' ? 'Enter the email address to send the test to.' : 'Enter the phone number to send the test to.';
    throw new HttpError(400, message, 'testRecipient');
}

export function readDraftRequest(body: JsonBody): DraftRequest {
    const { prompt, channels, subject, message } = body;
    if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 1_000) throw new HttpError(400, 'Describe the message in 3–1,000 characters.');
    if (!Array.isArray(channels) || !channels.length) throw new HttpError(400, 'Choose at least one channel.', 'channel');
    const currentSubject = optionalText(subject, 255);
    const currentMessage = optionalText(message, 8_000);
    return {
        prompt: prompt.trim(),
        channels: [...new Set(channels.map(readChannel))],
        ...(currentSubject ? { subject: currentSubject } : {}),
        ...(currentMessage ? { message: currentMessage } : {}),
    };
}

export function readReview(body: JsonBody): { recordId: number; outcome: 'SENT' | 'FAILED'; note: string } {
    const { recordId, outcome, note } = body;
    const validRecord = typeof recordId === 'number' && Number.isSafeInteger(recordId) && recordId >= 1;
    const validNote = typeof note === 'string' && note.trim() !== '' && note.length <= 1_000;
    if (!validRecord || (outcome !== 'SENT' && outcome !== 'FAILED') || !validNote) {
        throw new HttpError(400, 'Choose Sent or Failed and enter a review note of up to 1,000 characters.');
    }
    return { recordId, outcome, note: note.trim() };
}

function readGmailAddress(user: unknown): string {
    try {
        return normalizeEmail(typeof user === 'string' ? user : '');
    } catch {
        throw new HttpError(400, 'Enter the Gmail address you send from.', 'gmailUser');
    }
}

function optionalText(value: unknown, limit: number): string | undefined {
    return typeof value === 'string' && value.trim() ? value.slice(0, limit) : undefined;
}
