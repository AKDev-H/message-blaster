import { MAX_TYPED_RECIPIENTS } from '../../config/constants.js';
import type { TypedRecipient } from '../../services/excel/template.js';
import { HttpError } from '../http-error.js';
import { readText } from './fields.js';

const LIMITS = { name: 255, email: 320, phone: 40 } as const;
const unreadable = () => new HttpError(400, 'The recipient list could not be read.', 'recipients');

export function readTypedRecipients(form: FormData): TypedRecipient[] {
    const raw = readText(form, 'recipients', 256 * 1024, 'recipients');
    if (!raw) return [];
    const recipients = parseList(raw).map(readRecipient).filter(({ clientName, email, phone }) => clientName || email || phone);
    if (recipients.length > MAX_TYPED_RECIPIENTS) {
        throw new HttpError(400, `Type in up to ${MAX_TYPED_RECIPIENTS} recipients, or upload a workbook.`, 'recipients');
    }
    if (recipients.length && form.get('recipientsConsent') !== 'yes') {
        throw new HttpError(400, 'Confirm that everyone listed agreed to receive messages.', 'recipients');
    }
    return recipients;
}

function parseList(raw: string): unknown[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw unreadable();
    }
    if (!Array.isArray(parsed)) throw unreadable();
    return parsed;
}

function readRecipient(entry: unknown): TypedRecipient {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw unreadable();
    const fields = entry as Record<string, unknown>;
    return { clientName: readField(fields, 'name'), email: readField(fields, 'email'), phone: readField(fields, 'phone') };
}

function readField(fields: Record<string, unknown>, key: keyof typeof LIMITS): string {
    const raw = fields[key] ?? '';
    if (typeof raw !== 'string') throw unreadable();
    const value = raw.trim();
    if (value.length > LIMITS[key]) throw new HttpError(400, `Use ${LIMITS[key]} characters or fewer for each ${key}.`, 'recipients');
    return value;
}
