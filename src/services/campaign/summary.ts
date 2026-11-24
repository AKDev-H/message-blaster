import type { MessageRecord } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import { isOptedIn } from './template-values.js';

export function summarizeRecipients(messages: MessageRecord[], channel: CampaignChannel = 'whatsapp') {
    const count = (test: (message: MessageRecord) => boolean) => messages.filter(test).length;
    const mentions = (reason: string) => count(row => Boolean(row.errorMessage?.includes(reason)));
    return {
        totalContacts: messages.length,
        eligibleRecipients: count(row => row.eligible),
        optedIn: count(row => isOptedIn(row.consentStatus)),
        ...(channel === 'gmail' ? { invalidEmails: mentions('Invalid email address') } : { invalidNumbers: mentions('Invalid phone number') }),
        duplicates: mentions('Duplicate recipient'),
        missingAttachments: count(isMissingAttachment),
        attachmentErrors: mentions('Attachment error:'),
        consentIssues: count(row => /Consent is required|Consent withdrawn/i.test(row.errorMessage ?? '')),
    };
}

function isMissingAttachment(row: MessageRecord): boolean {
    return Boolean(row.errorMessage?.includes('Attachment error:') && /Attachment was not found/i.test(row.errorMessage));
}
