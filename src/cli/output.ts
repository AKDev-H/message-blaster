import { summarizeRecipients } from '../services/campaign/summary.js';
import type { MessageRecord, Store } from '../store/index.js';
import { terminalText } from '../utils/terminal.util.js';

export function printPreview(store: Store, id: string, limit: number): void {
    const campaign = store.getCampaign(id);
    const rows = store.listMessages(id);
    console.log(`Campaign ${id} (${campaign.channel}) is ${campaign.state}. Showing up to ${limit} recipient records.`);
    console.table([summarizeRecipients(rows, campaign.channel)]);
    for (const row of rows.slice(0, limit)) printRecipient(row);
}

export function printStatus(store: Store, id: string): void {
    const campaign = store.getCampaign(id);
    const rows = store.listMessages(id);
    console.log(`Campaign ${id} (${campaign.channel}) is ${campaign.state}.`);
    console.table([summarizeRecipients(rows, campaign.channel)]);
    console.table([store.progress(id)]);
    console.table([receiptTotals(rows, campaign.channel === 'whatsapp')]);
}

function printRecipient(row: MessageRecord): void {
    const lines = [
        `\n#${row.id} • Excel row ${row.rowNumber} • ${row.clientName} • ${row.email ?? row.phone}`,
        `${row.status} • Consent ${row.consentStatus || 'missing'}`,
        row.errorMessage, row.pdfFilename && `PDF ${row.pdfFilename}`, row.subject && `Subject ${row.subject}`, row.message,
    ];
    for (const line of lines) if (line) console.log(terminalText(line));
}

function receiptTotals(rows: MessageRecord[], hasReadReceipts: boolean) {
    const count = (key: 'sentAt' | 'acknowledgedAt' | 'deliveredAt' | 'readAt') => rows.filter(row => row[key]).length;
    return {
        submitted: count('sentAt'),
        serverAcknowledged: count('acknowledgedAt'),
        ...(hasReadReceipts ? { delivered: count('deliveredAt'), read: count('readAt') } : {}),
    };
}
