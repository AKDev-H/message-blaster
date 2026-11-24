import { readFile } from 'node:fs/promises';
import type { Environment } from '../config/env.js';
import { MAX_EMAIL_LENGTH, MAX_MESSAGE_LENGTH } from '../config/constants.js';
import type { CampaignChannel } from '../types/index.js';
import { normalizeEmail } from '../utils/email.util.js';
import { normalizePhone } from '../utils/phone.util.js';
import { renderTemplate } from '../utils/template.util.js';
import { readAttachment } from './attachment.service.js';
import { createResultsWorkbook, readExcel, writeExcel, type ImportRow } from './excel.service.js';
import type { Store, PreparedRow, MessageRecord } from './message.service.js';
import { renderRichScript } from './rich-script.js';

export interface CampaignOptions {
    source: string;
    templatePath?: string;
    channel?: CampaignChannel;
}

export async function importCampaign(store: Store, env: Environment, id: string, options: CampaignOptions) {
    const channel = options.channel ?? 'whatsapp';
    let template = '';
    if (options.templatePath) {
        template = await readFile(options.templatePath, 'utf8');
        if (template.length > MAX_EMAIL_LENGTH) throw new Error('Campaign template exceeds 32,767 characters.');
    }
    const rows = (await readExcel(options.source, channel)).filter(row => !row.campaignId || row.campaignId === id);
    if (rows.length === 0) throw new Error(`No rows match campaign ${id}. Check the workbook Campaign ID column.`);
    const prepared = await prepareRows(store, env, id, rows, template, channel);
    return store.importCampaign(id, prepared, false, channel);
}

export function campaignTemplateValues(channel: CampaignChannel, id: string, row?: ImportRow, address = '') {
    return {
        client_name: row?.clientName ?? '',
        ...(channel === 'gmail' ? { email_address: address } : { phone_number: address }),
        campaign_id: id,
        pdf_filename: row?.pdfFilename ?? '',
    };
}

export function isEmailSubject(subject: string): boolean {
    // eslint-disable-next-line no-control-regex -- Reject control characters in the email subject header.
    return Boolean(subject) && subject.length <= 255 && !/[\u0000-\u001f\u007f-\u009f]/u.test(subject);
}

export async function prepareRows(
    store: Pick<Store, 'isWithdrawn'>,
    env: Pick<Environment, 'DEFAULT_COUNTRY' | 'ATTACHMENTS_DIR'>,
    id: string,
    rows: ImportRow[],
    globalTemplate: string,
    channel: CampaignChannel = 'whatsapp',
    globalTemplateHtml?: string,
): Promise<PreparedRow[]> {
    const gmail = channel === 'gmail';
    const addressCounts = new Map<string, number>();
    const normalized = rows.map(row => {
        try {
            const address = gmail ? normalizeEmail(row.email ?? '') : normalizePhone(row.phone, env.DEFAULT_COUNTRY);
            addressCounts.set(address, (addressCounts.get(address) ?? 0) + 1);
            return { row, address };
        } catch {
            return { row, address: '' };
        }
    });
    const attachmentChecks = new Map<string, { hash: string } | { error: string }>();
    const prepared: PreparedRow[] = [];
    for (const { row, address } of normalized) {
        const recipient: PreparedRow = {
            rowNumber: row.rowNumber,
            clientName: row.clientName,
            phone: gmail ? '' : address || row.phone,
            ...(gmail ? { email: address || row.email || '', subject: row.subject ?? '' } : {}),
            message: row.message,
            pdfFilename: row.pdfFilename,
            consentStatus: row.consentStatus.toLowerCase() === 'opted in' ? 'Opted In' : row.consentStatus,
        };
        const errors: string[] = [];
        if (row.error) errors.push(row.error);
        if (!address) errors.push(gmail ? 'Invalid email address' : 'Invalid phone number');
        if (!row.clientName) errors.push('Client name is required');
        if ((addressCounts.get(address) ?? 0) > 1) errors.push('Duplicate recipient');
        if (row.consentStatus.toLowerCase() !== 'opted in') errors.push('Consent is required');
        if (address && store.isWithdrawn(address, channel)) errors.push('Consent withdrawn');
        if (errors.length === 0) {
            try {
                const fields = campaignTemplateValues(channel, id, row, address);
                if (!row.message.trim() && globalTemplateHtml) {
                    const rich = renderRichScript(globalTemplateHtml, fields);
                    recipient.message = rich.text;
                    if (gmail) recipient.messageHtml = rich.html;
                } else {
                    recipient.message = renderTemplate(row.message.trim() ? row.message : globalTemplate, fields);
                }
                if (gmail) {
                    const subject = renderTemplate(row.subject ?? '', fields).trim();
                    if (!isEmailSubject(subject)) {
                        throw new Error('Email subject must be a single line of 1–255 characters');
                    }
                    recipient.subject = subject;
                }
                const messageLimit = gmail ? MAX_EMAIL_LENGTH : MAX_MESSAGE_LENGTH;
                if (recipient.message.length > messageLimit) throw new Error(`Message exceeds ${messageLimit} characters`);
                if (!recipient.message.trim() && !row.pdfFilename) throw new Error('Message or attachment is required');
            } catch (error) {
                errors.push(error instanceof Error ? error.message : 'Invalid message template');
            }
        }
        if (row.pdfFilename) {
            let check = attachmentChecks.get(row.pdfFilename);
            if (!check) {
                try {
                    check = { hash: (await readAttachment(env.ATTACHMENTS_DIR, row.pdfFilename)).sha256 };
                } catch (error) {
                    check = { error: error instanceof Error ? error.message : 'Attachment validation failed' };
                }
                attachmentChecks.set(row.pdfFilename, check);
            }
            if ('hash' in check) recipient.attachmentHash = check.hash;
            else errors.push(`Attachment error: ${check.error}`);
        }
        if (errors.length) recipient.error = errors.join('; ');
        prepared.push(recipient);
    }
    return prepared;
}

export function summarizeRecipients(messages: MessageRecord[], channel: CampaignChannel = 'whatsapp') {
    const contains = (reason: string) => messages.filter(row => row.errorMessage?.includes(reason)).length;
    return {
        totalContacts: messages.length,
        eligibleRecipients: messages.filter(row => row.eligible).length,
        optedIn: messages.filter(row => row.consentStatus.toLowerCase() === 'opted in').length,
        ...(channel === 'gmail'
            ? { invalidEmails: contains('Invalid email address') }
            : { invalidNumbers: contains('Invalid phone number') }),
        duplicates: contains('Duplicate recipient'),
        missingAttachments: messages.filter(row =>
            row.errorMessage?.includes('Attachment error:') && /Attachment was not found/i.test(row.errorMessage),
        ).length,
        attachmentErrors: contains('Attachment error:'),
        consentIssues: messages.filter(row => /Consent is required|Consent withdrawn/i.test(row.errorMessage ?? '')).length,
    };
}

export function exportCampaign(store: Store, id: string, path: string): Promise<void> {
    const { channel } = store.getCampaign(id);
    return writeExcel(path, exportRows(store, id, channel), channel);
}

export function exportCampaignWorkbook(store: Store, id: string): Promise<Buffer> {
    const { channel } = store.getCampaign(id);
    return createResultsWorkbook(exportRows(store, id, channel), channel);
}

function exportRows(store: Store, id: string, channel: CampaignChannel) {
    return store.listMessages(id).map(row => ({
        clientName: row.clientName,
        phone: row.phone,
        message: row.message,
        pdfFilename: row.pdfFilename,
        consentStatus: row.consentStatus.toLowerCase() === 'opted in' ? 'Opted In' : row.consentStatus,
        campaignId: row.campaignId,
        sendingStatus: row.status,
        ...(channel === 'gmail'
            ? { email: row.email ?? '', subject: row.subject ?? '', gmailMessageId: row.transportMessageId }
            : { whatsappMessageId: row.transportMessageId }),
        sentAt: row.sentAt,
        errorMessage: row.errorMessage,
        retryCount: row.retryCount,
        serverAcknowledgedAt: row.acknowledgedAt,
        deliveredAt: row.deliveredAt,
        readAt: row.readAt,
    }));
}
