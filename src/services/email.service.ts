import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { MessageTransport, OutgoingMessage } from '../types/index.js';
import { normalizeEmail } from '../utils/email.util.js';
import { hasErrorCode } from '../utils/fs.util.js';
import { attachmentMimeType } from './attachment.service.js';
import { emailAccountId, type EmailSettings } from './email-account.js';

interface MailerOptions {
    host: string;
    port: number;
    secure: boolean;
    requireTLS?: true;
    auth?: { user: string; pass: string };
}

export class EmailService implements MessageTransport {
    readonly accountId: string;
    readonly #address: string;
    readonly #from: string | { name: string; address: string };
    readonly #server: string;
    readonly #settingsPlace: string;
    readonly #mailer;
    #verified = false;

    constructor(settings: EmailSettings) {
        const smtp = settings.EMAIL_PROVIDER === 'smtp';
        const options = smtp ? smtpOptions(settings) : gmailOptions(settings);
        this.#address = normalizeEmail(smtp ? settings.SMTP_FROM : settings.GMAIL_USER);
        this.#from = smtp && settings.SMTP_FROM_NAME ? { name: settings.SMTP_FROM_NAME, address: this.#address } : this.#address;
        this.#server = `${options.host} port ${options.port}`;
        this.#settingsPlace = smtp ? 'the SMTP username and password in Settings › Email' : 'the address and App Password in Settings › Email';
        this.accountId = emailAccountId(settings) ?? `email:${this.#address}`;
        this.#mailer = createMailer(options);
    }

    get isReady(): boolean {
        return this.#verified;
    }

    async connect(): Promise<void> {
        const verified = await this.#mailer.verify().catch((error: unknown) => this.#connectionFailure(error));
        if (verified instanceof Error) throw verified;
        this.#verified = verified;
        if (!verified) throw new Error(`Could not verify SMTP on ${this.#server}.`);
    }

    createMessageId(): string {
        return `<${randomUUID()}@${this.#address.split('@')[1]}>`;
    }

    async send(message: OutgoingMessage): Promise<{ acknowledged: true }> {
        if (!this.isReady || !message.email || !message.subject) throw new Error('Email submission is unavailable');
        const result = await this.#mailer.sendMail(this.mail(message, message.email, message.subject));
        if (result.accepted.length !== 1) throw new Error('The mail server did not accept the message');
        return { acknowledged: true };
    }

    private mail(message: OutgoingMessage, to: string, subject: string) {
        return {
            from: this.#from,
            to: normalizeEmail(to),
            subject,
            text: message.text,
            messageId: message.id,
            ...(message.html ? { html: message.html } : {}),
            ...(message.attachment ? { attachments: [attachmentOf(message.attachment)] } : {}),
        };
    }

    #connectionFailure(error: unknown): Error {
        return new Error(hasErrorCode(error, 'EAUTH')
            ? `The mail server rejected the sign-in. Check ${this.#settingsPlace}.`
            : `Could not verify SMTP on ${this.#server}.`);
    }
}

function gmailOptions(settings: EmailSettings): MailerOptions {
    const pass = settings.GMAIL_APP_PASSWORD.replace(/\s/g, '');
    if (!settings.GMAIL_USER.trim() || !pass) throw new Error('Add your Gmail address and App Password in Settings › Email.');
    if (!/^[a-z0-9]{16}$/i.test(pass)) throw new Error('GMAIL_APP_PASSWORD must be a 16-character Google App Password.');
    return { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: normalizeEmail(settings.GMAIL_USER), pass } };
}

function smtpOptions(settings: EmailSettings): MailerOptions {
    const host = settings.SMTP_HOST.trim();
    if (!host || !settings.SMTP_FROM.trim()) throw new Error('Add your SMTP server and From address in Settings › Email.');
    const user = settings.SMTP_USER.trim();
    if (user && !settings.SMTP_PASSWORD) throw new Error('Add the SMTP password in Settings › Email.');
    const secure = settings.SMTP_SECURITY === 'tls';
    return { host, port: settings.SMTP_PORT, secure, ...(secure ? {} : { requireTLS: true as const }), ...(user ? { auth: { user, pass: settings.SMTP_PASSWORD } } : {}) };
}

function createMailer(options: MailerOptions) {
    return nodemailer.createTransport({
        ...options,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        disableFileAccess: true,
        disableUrlAccess: true,
    });
}

function attachmentOf({ name, data }: { name: string; data: Buffer }) {
    return { filename: name, content: data, contentType: attachmentMimeType(name) };
}
