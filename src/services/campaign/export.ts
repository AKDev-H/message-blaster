import type { Store, MessageRecord } from '../../store/index.js';
import type { CampaignChannel } from '../../types/index.js';
import type { ExportRow } from '../excel/columns.js';
import { createResultsWorkbook, writeExcel } from '../excel/write.js';
import { displayConsent } from './template-values.js';

export function exportCampaign(store: Store, id: string, path: string): Promise<void> {
    const { channel } = store.getCampaign(id);
    return writeExcel(path, exportRows(store, id, channel), channel);
}

export function exportCampaignWorkbook(store: Store, id: string): Promise<Buffer> {
    const { channel } = store.getCampaign(id);
    return createResultsWorkbook(exportRows(store, id, channel), channel);
}

function exportRows(store: Store, id: string, channel: CampaignChannel): ExportRow[] {
    return store.listMessages(id).map(row => ({ ...inputColumns(row), ...transportColumns(row, channel), ...resultColumns(row) }));
}

function inputColumns(row: MessageRecord) {
    return {
        clientName: row.clientName,
        phone: row.phone,
        message: row.message,
        pdfFilename: row.pdfFilename,
        consentStatus: displayConsent(row.consentStatus),
        campaignId: row.campaignId,
    };
}

function transportColumns(row: MessageRecord, channel: CampaignChannel) {
    if (channel !== 'gmail') return { whatsappMessageId: row.transportMessageId };
    return { email: row.email ?? '', subject: row.subject ?? '', gmailMessageId: row.transportMessageId };
}

function resultColumns(row: MessageRecord) {
    return {
        sendingStatus: row.status,
        sentAt: row.sentAt,
        errorMessage: row.errorMessage,
        retryCount: row.retryCount,
        serverAcknowledgedAt: row.acknowledgedAt,
        deliveredAt: row.deliveredAt,
        readAt: row.readAt,
    };
}
