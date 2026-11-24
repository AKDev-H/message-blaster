import { createHash } from 'node:crypto';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export function whatsappAccountId(jid: string): string | undefined {
    const normalized = jidNormalizedUser(jid);
    return normalized ? createHash('sha256').update(normalized).digest('hex') : undefined;
}

export function whatsappJid(phone: string): string {
    return `${phone.slice(1)}@s.whatsapp.net`;
}
