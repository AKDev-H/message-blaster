export const MESSAGE_STATUSES = [
    'PENDING', 'VALIDATING', 'QUEUED', 'SENDING', 'SENT',
    'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'UNKNOWN',
] as const;

export type MessageStatus = typeof MESSAGE_STATUSES[number];
export const CAMPAIGN_CHANNEL_LABELS = { whatsapp: 'WhatsApp', gmail: 'Gmail' } as const;
export type CampaignChannel = keyof typeof CAMPAIGN_CHANNEL_LABELS;
export type CampaignState = 'Draft' | 'Ready' | 'Running' | 'Paused' | 'Completed' | 'Failed' | 'Cancelled';
export type ReceiptStage = 'ACKNOWLEDGED' | 'DELIVERED' | 'READ' | 'REJECTED';

export interface OutgoingMessage {
    id: string;
    phone: string;
    text: string;
    html?: string;
    email?: string;
    subject?: string;
    attachment?: { name: string; data: Buffer };
}

export interface MessageTransport {
    readonly isReady: boolean;
    waitUntilReady?(signal?: AbortSignal): Promise<void>;
    createMessageId?(): string;
    send(message: OutgoingMessage): Promise<void | { acknowledged: true }>;
}
