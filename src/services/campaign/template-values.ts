import type { CampaignChannel } from '../../types/index.js';
import type { ImportRow } from '../excel/columns.js';

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

export function isOptedIn(consentStatus: string): boolean {
    return consentStatus.toLowerCase() === 'opted in';
}

export function displayConsent(consentStatus: string): string {
    return isOptedIn(consentStatus) ? 'Opted In' : consentStatus;
}
