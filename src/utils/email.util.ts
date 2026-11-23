import { z } from 'zod';

const emailAddress = z.email().max(254);

export function normalizeEmail(value: string): string {
    const email = value.trim().toLowerCase();
    if (!emailAddress.safeParse(email).success || email.indexOf('@') > 64) {
        throw new Error('Invalid email address');
    }
    return email;
}
