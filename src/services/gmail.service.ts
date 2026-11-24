import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Environment } from '../config/env.js';
import type { MessageTransport, OutgoingMessage } from '../types/index.js';
import { attachmentMimeType } from './attachment.service.js';
import { normalizeEmail } from '../utils/email.util.js';

export class GmailService implements MessageTransport {
    readonly accountId: string;
    readonly #address: string;
    readonly #mailer;
    #verified = false;

    constructor(env: Pick<Environment, 'GMAIL_USER' | 'GMAIL_APP_PASSWORD'>) {
        const pass = env.GMAIL_APP_PASSWORD.replace(/\s/g, '');
        if (!env.GMAIL_USER.trim() || !pass) {
            throw new Error('Add your Gmail address and App Password in Settings › Gmail.');
        }
        this.#address = normalizeEmail(env.GMAIL_USER);
        if (!/^[a-z0-9]{16}$/i.test(pass)) throw new Error('GMAIL_APP_PASSWORD must be a 16-character Google App Password.');
        this.accountId = `gmail:${this.#address}`;
        this.#mailer = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: this.#address, pass },
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 60_000,
            disableFileAccess: true,
            disableUrlAccess: true,
        });
    }

    get isReady(): boolean {
        return this.#verified;
    }

    async connect(): Promise<void> {
        try {
            this.#verified = await this.#mailer.verify();
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'EAUTH') {
                // eslint-disable-next-line preserve-caught-error -- SMTP authentication errors may carry account details.
                throw new Error('Gmail rejected the sign-in. Check the address and App Password in Settings › Gmail.');
            }
            // eslint-disable-next-line preserve-caught-error -- Keep raw SMTP responses out of the surfaced error.
            throw new Error('Could not verify Gmail SMTP on smtp.gmail.com port 465.');
        }
        if (!this.#verified) throw new Error('Could not verify Gmail SMTP.');
    }

    createMessageId(): string {
        return `<${randomUUID()}@${this.#address.split('@')[1]}>`;
    }

    async send(message: OutgoingMessage): Promise<{ acknowledged: true }> {
        if (!this.isReady || !message.email || !message.subject) throw new Error('Email submission is unavailable');
        const result = await this.#mailer.sendMail({
            from: this.#address,
            to: normalizeEmail(message.email),
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
            messageId: message.id,
            ...(message.attachment ? { attachments: [{
                filename: message.attachment.name,
                content: message.attachment.data,
                contentType: attachmentMimeType(message.attachment.name),
            }] } : {}),
        });
        if (result.accepted.length !== 1) throw new Error('Gmail did not accept the message');
        return { acknowledged: true };
    }
}
