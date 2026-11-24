import { DisconnectReason } from '@whiskeysockets/baileys';
import { LOGGED_OUT_ERROR, type WhatsAppAuth } from './auth.js';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const RECOVERABLE_DISCONNECTS = new Set<number>([
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.restartRequired,
    DisconnectReason.unavailableService,
]);

export interface ClosedConnection {
    error: unknown;
    opened: boolean;
}

export function statusCode(error: unknown): number | undefined {
    return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

export function reconnectDelay(closed: ClosedConnection, auth: WhatsAppAuth, reconnects: number): number {
    throwIfPermanent(statusCode(closed.error), closed.opened, auth);
    const wait = RECONNECT_DELAYS_MS[reconnects];
    if (wait === undefined) throw new Error('WhatsApp reconnect attempts exhausted.');
    return wait;
}

function throwIfPermanent(code: number | undefined, opened: boolean, auth: WhatsAppAuth): void {
    if (code === DisconnectReason.loggedOut) {
        auth.markLoggedOut();
        throw new Error(LOGGED_OUT_ERROR);
    }
    if (code === DisconnectReason.forbidden || code === DisconnectReason.multideviceMismatch) {
        throw new Error(`WhatsApp declined the connection (${code}). Review your account in WhatsApp.`);
    }
    if (!auth.state.creds.me?.id && !opened) throw new Error('WhatsApp closed before pairing finished. Run whatsapp:connect again to get a new QR code.');
    if (code === undefined || !RECOVERABLE_DISCONNECTS.has(code)) {
        throw new Error(`WhatsApp connection closed${code === undefined ? '' : ` (${code})`}. Review it before reconnecting.`);
    }
}
