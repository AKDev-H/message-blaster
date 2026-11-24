import { isFilled } from './rows.mjs';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_PATTERN = /^\+?[\d\s().-]+$/u;

const isPhone = value => PHONE_PATTERN.test(value) && value.replaceAll(/\D/gu, '').length >= 6;

/**
 * The first problem with the typed recipients, as { message, index, key } so the
 * cell can be focused, or null when the list is fine. When editing, an empty list keeps the old recipients.
 */
export function firstProblem(rows, keys, consented, editing) {
    if (!rows.some(isFilled)) return editing ? null : { message: 'Add at least one recipient.', index: 0, key: keys[0] };
    for (const [index, row] of rows.entries()) {
        const problem = isFilled(row) ? rowProblem(row, keys) : null;
        if (problem) return { message: `Row ${index + 1}: ${problem.message}`, index, key: problem.key };
    }
    return consented ? null : { message: 'Confirm that everyone listed agreed to receive messages.' };
}

/** With both channels, either an email or a phone is enough. */
function rowProblem(row, keys) {
    const wantsEmail = keys.includes('email');
    const wantsPhone = keys.includes('phone');
    const email = row.email.trim();
    const phone = row.phone.trim();
    if (!row.name.trim()) return { key: 'name', message: 'enter a name.' };
    if (wantsEmail && wantsPhone && !email && !phone) return { key: 'email', message: 'enter an email address or phone number.' };
    if (wantsEmail && !wantsPhone && !email) return { key: 'email', message: 'enter an email address.' };
    if (wantsPhone && !wantsEmail && !phone) return { key: 'phone', message: 'enter a phone number.' };
    if (wantsEmail && email && !EMAIL_PATTERN.test(email)) return { key: 'email', message: 'check the email address.' };
    if (wantsPhone && phone && !isPhone(phone)) return { key: 'phone', message: 'check the phone number.' };
    return null;
}
