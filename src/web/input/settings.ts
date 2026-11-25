import { isSupportedCountry } from 'libphonenumber-js';
import type { DraftRequest } from '../../services/ai.service.js';
import type { EditableSettings } from '../../services/settings.service.js';
import type { CampaignChannel } from '../../types/index.js';
import { normalizeEmail } from '../../utils/email.util.js';
import { HttpError, type DraftField } from '../http-error.js';
import type { JsonBody } from './body.js';
import { readChannel } from './fields.js';

interface SavedPasswords {
    gmail: boolean;
    smtp: boolean;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

export function readEmailSettings(body: JsonBody, saved: SavedPasswords): Partial<EditableSettings> {
    if (body.provider === 'smtp') return { EMAIL_PROVIDER: 'smtp', ...readSmtpSettings(objectField(body.smtp), saved.smtp) };
    if (body.provider !== undefined && body.provider !== 'gmail') throw new HttpError(400, 'Choose Gmail App Password or SMTP.');
    return { EMAIL_PROVIDER: 'gmail', ...readGmailSettings(body.gmail === undefined ? body : objectField(body.gmail), saved.gmail) };
}

function readGmailSettings(body: JsonBody, hasPassword: boolean): Partial<EditableSettings> {
    const address = readAddress(body.user, 'Enter the Gmail address you send from.', 'gmailUser');
    const pass = typeof body.password === 'string' ? body.password.replaceAll(/\s/gu, '') : '';
    if (!pass && !hasPassword) throw new HttpError(400, 'Enter the 16-character App Password.', 'gmailPassword');
    if (pass && !/^[a-z0-9]{16}$/iu.test(pass)) throw new HttpError(400, 'An App Password has 16 letters and numbers.', 'gmailPassword');
    return { GMAIL_USER: address, ...(pass ? { GMAIL_APP_PASSWORD: pass } : {}) };
}

function readSmtpSettings(body: JsonBody, hasPassword: boolean): Partial<EditableSettings> {
    const host = typeof body.host === 'string' ? body.host.trim().toLowerCase() : '';
    if (!HOSTNAME.test(host)) throw new HttpError(400, 'Enter the SMTP server, like smtp.example.com.', 'smtpHost');
    const { port, security } = body;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new HttpError(400, 'Use a port from 1 to 65,535.', 'smtpPort');
    if (security !== 'tls' && security !== 'starttls') throw new HttpError(400, 'Choose how to secure the connection.', 'smtpSecurity');
    const user = boundedText(body.user, 320);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length > 1_024) throw new HttpError(400, 'The password is too long.', 'smtpPassword');
    if (user && !password && !hasPassword) throw new HttpError(400, 'Enter the SMTP password.', 'smtpPassword');
    const from = readAddress(body.from, 'Enter the address emails are sent from.', 'smtpFrom');
    const fromName = boundedText(body.fromName, 120).replaceAll(/[\r\n"<>]/gu, '');
    return {
        SMTP_HOST: host, SMTP_PORT: port, SMTP_SECURITY: security, SMTP_USER: user, SMTP_FROM: from, SMTP_FROM_NAME: fromName,
        ...(password ? { SMTP_PASSWORD: password } : {}),
    };
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

function readAddress(value: unknown, message: string, field: DraftField): string {
    try {
        return normalizeEmail(typeof value === 'string' ? value : '');
    } catch {
        throw new HttpError(400, message, field);
    }
}

function objectField(value: unknown): JsonBody {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Send the email settings as an object.');
    return value as JsonBody;
}

function boundedText(value: unknown, limit: number): string {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function optionalText(value: unknown, limit: number): string | undefined {
    return typeof value === 'string' && value.trim() ? value.slice(0, limit) : undefined;
}
