import type { CampaignChannel } from '../../types/index.js';
import type { ImportRow } from '../excel/columns.js';
import { hasControlCharacters } from '../../utils/text.util.js';

export function campaignTemplateValues(channel: CampaignChannel, id: string, row?: ImportRow, address = '') {
    return {
        client_name: row?.clientName ?? '',
        ...(channel === 'gmail' ? { email_address: address } : { phone_number: address }),
        campaign_id: id,
        pdf_filename: row?.pdfFilename ?? '',
    };
}

export function isEmailSubject(subject: string): boolean {
    return Boolean(subject) && subject.length <= 255 && !hasControlCharacters(subject, { extended: true });
}

export function isOptedIn(consentStatus: string): boolean {
    return consentStatus.toLowerCase() === 'opted in';
}

export function displayConsent(consentStatus: string): string {
    return isOptedIn(consentStatus) ? 'Opted In' : consentStatus;
}
