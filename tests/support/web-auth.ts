import assert from 'node:assert/strict';
import { type AuthRole, AuthStore } from '../../src/auth/store.js';
import type { GoogleProvider } from '../../src/auth/google.js';
import { openDatabase } from '../../src/database/connection.js';

export const TEST_EMAIL = 'dashboard@gmail.com';

export function mockGoogle(email = TEST_EMAIL): GoogleProvider {
    return {
        authorize: ({ state, nonce }) => '/auth/callback?' + new URLSearchParams({ state, code: nonce }),
        exchange: async ({ code }) => ({ subject: email, email, emailVerified: true, nonce: code }),
    };
}

export function approveTestUser(database: string, role: AuthRole = 'admin'): void {
    using db = openDatabase(database);
    new AuthStore(db).allowUser(TEST_EMAIL, role);
}

export async function testLogin(url: string): Promise<string> {
    const start = await fetch(`${url}/auth/google`, { method: 'POST', headers: { Origin: url } });
    assert.equal(start.status, 200);
    const { url: callback } = await start.json() as { url: string };
    const response = await fetch(new URL(callback, url), {
        headers: { Cookie: start.headers.getSetCookie()[0]!.split(';')[0]! }, redirect: 'manual',
    });
    assert.equal(response.headers.get('location'), '/');
    return response.headers.getSetCookie().find(value => value.startsWith('blaster_session='))!.split(';')[0]!;
}

export function authenticatedFetch(url: string, cookie: string) {
    return (path: string, options?: RequestInit) => {
        const headers = new Headers({ Cookie: cookie, Origin: url });
        new Headers(options?.headers).forEach((value, key) => headers.set(key, value));
        return fetch(`${url}${path}`, { ...options, headers });
    };
}
