import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Environment } from '../config/env.js';
import type { MessageTransport, OutgoingMessage } from '../types/index.js';
import { normalizeEmail } from '../utils/email.util.js';
import { hasErrorCode } from '../utils/fs.util.js';
import { attachmentMimeType } from './attachment.service.js';

type GmailSettings = Pick<Environment, 'GMAIL_USER' | 'GMAIL_APP_PASSWORD'>;

export class GmailService implements MessageTransport {
    readonly accountId: string;
    readonly #address: string;
    readonly #mailer;
    #verified = false;

    constructor(env: GmailSettings) {
        const password = appPassword(env);
        this.#address = normalizeEmail(env.GMAIL_USER);
        if (!/^[a-z0-9]{16}$/i.test(password)) throw new Error('GMAIL_APP_PASSWORD must be a 16-character Google App Password.');
        this.accountId = `gmail:${this.#address}`;
        this.#mailer = createMailer(this.#address, password);
    }

    get isReady(): boolean {
        return this.#verified;
    }

    async connect(): Promise<void> {
        try {
            this.#verified = await this.#mailer.verify();
        } catch (error) {
            // eslint-disable-next-line preserve-caught-error -- Keep raw SMTP responses out of the surfaced error.
            throw new Error(hasErrorCode(error, 'EAUTH')
                ? 'Gmail rejected the sign-in. Check the address and App Password in Settings › Gmail.'
                : 'Could not verify Gmail SMTP on smtp.gmail.com port 465.');
        }
        if (!this.#verified) throw new Error('Could not verify Gmail SMTP.');
    }

    createMessageId(): string {
        return `<${randomUUID()}@${this.#address.split('@')[1]}>`;
    }

    async send(message: OutgoingMessage): Promise<{ acknowledged: true }> {
        if (!this.isReady || !message.email || !message.subject) throw new Error('Email submission is unavailable');
        const result = await this.#mailer.sendMail(this.mail(message, message.email, message.subject));
        if (result.accepted.length !== 1) throw new Error('Gmail did not accept the message');
        return { acknowledged: true };
    }

    private mail(message: OutgoingMessage, to: string, subject: string) {
        return {
            from: this.#address,
            to: normalizeEmail(to),
            subject,
            text: message.text,
            messageId: message.id,
            ...(message.html ? { html: message.html } : {}),
            ...(message.attachment ? { attachments: [attachmentOf(message.attachment)] } : {}),
        };
    }
}

function appPassword(env: GmailSettings): string {
    const password = env.GMAIL_APP_PASSWORD.replace(/\s/g, '');
    if (!env.GMAIL_USER.trim() || !password) throw new Error('Add your Gmail address and App Password in Settings › Gmail.');
    return password;
}

function createMailer(user: string, pass: string) {
    return nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass },
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
