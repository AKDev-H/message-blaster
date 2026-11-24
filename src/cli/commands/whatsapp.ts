import type { Command } from 'commander';
import { wait, withWhatsAppSession } from '../../services/live-campaign.service.js';
import type { WhatsAppService } from '../../services/whatsapp/service.js';
import { withDb } from '../context.js';

export function registerWhatsAppCommands(program: Command): void {
    program.command('whatsapp:connect').description('Link WhatsApp Business through a terminal QR code')
        .option('--listen', 'Keep the connection open for receipt updates')
        .action(({ listen }: { listen?: boolean }) => withDb((store, env) => withWhatsAppSession(store, env, true, async ({ socket, signal }) => {
            console.log('WhatsApp connected.');
            if (listen) await listenForReceipts(socket, signal);
        })));
}

async function listenForReceipts(socket: WhatsAppService, signal: AbortSignal): Promise<void> {
    console.log('Listening for receipts. Press Ctrl+C to close.');
    while (!signal.aborted) {
        await wait(1_000, signal);
        if (!signal.aborted && !socket.isReady) await socket.waitUntilReady(signal);
    }
}
