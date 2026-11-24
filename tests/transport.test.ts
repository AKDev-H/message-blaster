import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pino from 'pino';
import { acquireWhatsAppLease, openWhatsAppAuth, privateDirectory } from '../src/services/whatsapp/auth.js';
import { WhatsAppService } from '../src/services/whatsapp/service.js';

test('auth persists credentials and keys privately, and logged-out sessions require re-pairing', async context => {
    const path = await mkdtemp(join(tmpdir(), 'bulk-auth-'));
    context.after(() => rm(path, { recursive: true, force: true }));
    const directory = privateDirectory(join(path, 'auth'));
    const auth = openWhatsAppAuth(directory);
    const storedKey = auth.state.creds.noiseKey.public;
    await auth.state.keys.set({ session: { sessionExample: Buffer.from('session-example') } });
    auth.saveCreds();
    auth.close();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'auth-state.sqlite'))).mode & 0o777, 0o600);

    const restored = openWhatsAppAuth(directory);
    assert.deepEqual(restored.state.creds.noiseKey.public, storedKey);
    const session = await restored.state.keys.get('session', ['sessionExample']);
    assert.deepEqual(session.sessionExample, Buffer.from('session-example'));
    restored.markLoggedOut();
    restored.close();
    assert.throws(() => openWhatsAppAuth(directory), /logged out/);
});

test('auth lease is exclusive and live transport refuses a missing session before opening a socket', async context => {
    const path = await mkdtemp(join(tmpdir(), 'bulk-lease-'));
    context.after(() => rm(path, { recursive: true, force: true }));
    const lock = join(path, 'auth', 'connection-lock.sqlite');
    const first = acquireWhatsAppLease(lock, 'Already connected');
    try {
        assert.throws(() => acquireWhatsAppLease(lock, 'Already connected'), /Already connected/);
    } finally {
        first.close();
    }

    const socket = new WhatsAppService(join(path, 'auth'), pino({ level: 'silent' }), () => {});
    try {
        await assert.rejects(socket.connect(), /not paired/);
        assert.equal(socket.isReady, false);
    } finally {
        await socket.close();
    }
});
