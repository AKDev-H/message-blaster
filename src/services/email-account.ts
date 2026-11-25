import type { AppSettings } from '../config/env.js';
import { normalizeEmail } from '../utils/email.util.js';

export type EmailSettings = Pick<AppSettings,
    'EMAIL_PROVIDER' | 'GMAIL_USER' | 'GMAIL_APP_PASSWORD' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURITY' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_FROM' | 'SMTP_FROM_NAME'>;

export const EMAIL_SETUP_HINT = {
    gmail: 'Save your Gmail address and App Password',
    smtp: 'Save your SMTP server details',
} as const;

export function emailSenderAddress(settings: EmailSettings): string {
    return settings.EMAIL_PROVIDER === 'smtp' ? settings.SMTP_FROM : settings.GMAIL_USER;
}

export function isEmailConfigured(settings: EmailSettings): boolean {
    if (settings.EMAIL_PROVIDER === 'gmail') return Boolean(settings.GMAIL_USER && settings.GMAIL_APP_PASSWORD);
    return Boolean(settings.SMTP_HOST && settings.SMTP_FROM && (settings.SMTP_PASSWORD || !settings.SMTP_USER));
}

export function emailAccountId(settings: EmailSettings): string | null {
    try {
        const address = emailSenderAddress(settings);
        if (!address) return null;
        if (settings.EMAIL_PROVIDER === 'gmail') return `gmail:${normalizeEmail(address)}`;
        return settings.SMTP_HOST ? `smtp:${settings.SMTP_HOST.toLowerCase()}:${normalizeEmail(address)}` : null;
    } catch {
        return null;
    }
}
