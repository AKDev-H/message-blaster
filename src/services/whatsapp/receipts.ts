import { proto, toNumber, type MessageUserReceipt } from '@whiskeysockets/baileys';
import type { ReceiptStage } from '../../types/index.js';

const Status = proto.WebMessageInfo.Status;
const STAGE_BY_STATUS = new Map<number, ReceiptStage>([
    [Status.ERROR, 'REJECTED'],
    [Status.SERVER_ACK, 'ACKNOWLEDGED'],
    [Status.DELIVERY_ACK, 'DELIVERED'],
    [Status.READ, 'READ'],
    [Status.PLAYED, 'READ'],
]);

export const RESTRICTION_CODE = '463';

export function stageOfStatus(status: number | null | undefined): ReceiptStage | undefined {
    return status == null ? undefined : STAGE_BY_STATUS.get(status);
}

export function stageOfReceipt(receipt: MessageUserReceipt): ReceiptStage | undefined {
    const happened = (timestamp: unknown) => toNumber((timestamp ?? undefined) as Parameters<typeof toNumber>[0]) > 0;
    if (happened(receipt.readTimestamp) || happened(receipt.playedTimestamp)) return 'READ';
    return happened(receipt.receiptTimestamp) ? 'DELIVERED' : undefined;
}
