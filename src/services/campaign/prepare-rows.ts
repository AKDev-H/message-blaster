import type { Environment } from '../../config/env.js';
import { MAX_EMAIL_LENGTH, MAX_MESSAGE_LENGTH } from '../../config/constants.js';
import type { PreparedRow, Store } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { normalizeEmail } from '../../utils/email.util.js';
import { errorMessage } from '../../utils/fs.util.js';
import { normalizePhone } from '../../utils/phone.util.js';
import { renderTemplate } from '../../utils/template.util.js';
import { readAttachment } from '../attachment.service.js';
import type { ImportRow } from '../excel/columns.js';
import { renderRichScript } from '../rich-script.js';
import { campaignTemplateValues, displayConsent, isEmailSubject, isOptedIn } from './template-values.js';

type Settings = Pick<Environment, 'DEFAULT_COUNTRY' | 'ATTACHMENTS_DIR'>;
type AttachmentCheck = { hash: string } | { error: string };

interface Preparation {
    id: string;
    channel: CampaignChannel;
    gmail: boolean;
    template: { text: string; html: string | undefined };
    isWithdrawn: (address: string) => boolean;
    checkAttachment: (name: string) => Promise<AttachmentCheck>;
}

export async function prepareRows(
    store: Pick<Store, 'isWithdrawn'>,
    env: Settings,
    id: string,
    rows: ImportRow[],
    globalTemplate: string,
    channel: CampaignChannel = 'whatsapp',
    globalTemplateHtml?: string,
): Promise<PreparedRow[]> {
    const preparation = startPreparation(store, env, id, channel, { text: globalTemplate, html: globalTemplateHtml });
    const addresses = rows.map(row => normalizeAddress(row, channel, env));
    const isDuplicate = duplicateFinder(addresses);
    const prepared: PreparedRow[] = [];
    for (const [index, row] of rows.entries()) prepared.push(await prepareRow(preparation, row, addresses[index]!, isDuplicate));
    return prepared;
}

function startPreparation(store: Pick<Store, 'isWithdrawn'>, env: Settings, id: string, channel: CampaignChannel,
    template: Preparation['template']): Preparation {
    return {
        id, channel, template,
        gmail: channel === 'gmail',
        isWithdrawn: address => store.isWithdrawn(address, channel),
        checkAttachment: attachmentChecker(env.ATTACHMENTS_DIR),
    };
}

async function prepareRow(preparation: Preparation, row: ImportRow, address: string, isDuplicate: (address: string) => boolean) {
    const recipient = recipientFromRow(row, address, preparation.gmail);
    const errors = eligibilityErrors(preparation, row, address, isDuplicate(address));
    if (!errors.length) collectError(errors, () => renderMessage(preparation, row, address, recipient));
    if (row.pdfFilename) await checkAttachment(preparation, recipient, errors);
    if (errors.length) recipient.error = errors.join('; ');
    return recipient;
}

function recipientFromRow(row: ImportRow, address: string, gmail: boolean): PreparedRow {
    return {
        rowNumber: row.rowNumber,
        clientName: row.clientName,
        phone: gmail ? '' : address || row.phone,
        ...(gmail ? { email: address || row.email || '', subject: row.subject ?? '' } : {}),
        message: row.message,
        pdfFilename: row.pdfFilename,
        consentStatus: displayConsent(row.consentStatus),
    };
}

function eligibilityErrors(preparation: Preparation, row: ImportRow, address: string, duplicate: boolean): string[] {
    const errors = row.error ? [row.error] : [];
    if (!address) errors.push(preparation.gmail ? 'Invalid email address' : 'Invalid phone number');
    if (!row.clientName) errors.push('Client name is required');
    if (duplicate) errors.push('Duplicate recipient');
    if (!isOptedIn(row.consentStatus)) errors.push('Consent is required');
    if (address && preparation.isWithdrawn(address)) errors.push('Consent withdrawn');
    return errors;
}

function renderMessage(preparation: Preparation, row: ImportRow, address: string, recipient: PreparedRow): void {
    const fields = campaignTemplateValues(preparation.channel, preparation.id, row, address);
    Object.assign(recipient, renderBody(preparation, row, fields));
    if (preparation.gmail) recipient.subject = renderSubject(row, fields);
    checkMessageSize(recipient.message, row, preparation.gmail);
}

function renderBody(preparation: Preparation, row: ImportRow, fields: Record<string, string>) {
    const ownMessage = row.message.trim() ? row.message : '';
    if (ownMessage || !preparation.template.html) return { message: renderTemplate(ownMessage || preparation.template.text, fields) };
    const rich = renderRichScript(preparation.template.html, fields);
    return preparation.gmail ? { message: rich.text, messageHtml: rich.html } : { message: rich.text };
}

function renderSubject(row: ImportRow, fields: Record<string, string>): string {
    const subject = renderTemplate(row.subject ?? '', fields).trim();
    if (!isEmailSubject(subject)) throw new Error('Email subject must be a single line of 1–255 characters');
    return subject;
}

function checkMessageSize(message: string, row: ImportRow, gmail: boolean): void {
    const limit = gmail ? MAX_EMAIL_LENGTH : MAX_MESSAGE_LENGTH;
    if (message.length > limit) throw new Error(`Message exceeds ${limit} characters`);
    if (!message.trim() && !row.pdfFilename) throw new Error('Message or attachment is required');
}

async function checkAttachment(preparation: Preparation, recipient: PreparedRow, errors: string[]): Promise<void> {
    const check = await preparation.checkAttachment(recipient.pdfFilename);
    if ('hash' in check) recipient.attachmentHash = check.hash;
    else errors.push(`Attachment error: ${check.error}`);
}

function normalizeAddress(row: ImportRow, channel: CampaignChannel, env: Settings): string {
    try {
        return channel === 'gmail' ? normalizeEmail(row.email ?? '') : normalizePhone(row.phone, env.DEFAULT_COUNTRY);
    } catch {
        return '';
    }
}

function duplicateFinder(addresses: readonly string[]): (address: string) => boolean {
    const counts = new Map<string, number>();
    for (const address of addresses) if (address) counts.set(address, (counts.get(address) ?? 0) + 1);
    return address => (counts.get(address) ?? 0) > 1;
}

function attachmentChecker(directory: string): (name: string) => Promise<AttachmentCheck> {
    const checks = new Map<string, Promise<AttachmentCheck>>();
    return name => {
        if (!checks.has(name)) checks.set(name, readAttachmentHash(directory, name));
        return checks.get(name)!;
    };
}

async function readAttachmentHash(directory: string, name: string): Promise<AttachmentCheck> {
    try {
        return { hash: (await readAttachment(directory, name)).sha256 };
    } catch (error) {
        return { error: errorMessage(error, 'Attachment validation failed') };
    }
}

function collectError(errors: string[], step: () => void): void {
    try {
        step();
    } catch (error) {
        errors.push(errorMessage(error, 'Invalid message template'));
    }
}
