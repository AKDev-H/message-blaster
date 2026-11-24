import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoogleProvider, type GoogleIdentity, type GoogleProvider } from '../src/auth/google.js';
import { AuthService } from '../src/auth/service.js';
import { AuthStore } from '../src/auth/store.js';
import { backupDatabase, openDatabase } from '../src/database/connection.js';

function mockGoogle() {
    let challenge = '';
    let nonce = '';
    let state = '';
    const identity: Omit<GoogleIdentity, 'nonce'> = { subject: 'google-account-1', email: 'operator@gmail.com', emailVerified: true };
    const provider: GoogleProvider = {
        authorize: request => {
            ({ challenge, nonce, state } = request);
            return 'https://accounts.google.com/';
        },
        exchange: ({ code, verifier }) => {
            assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
            return Promise.resolve({ ...identity, ...(code !== 'missing-nonce' && { nonce }) });
        },
    };
    return { provider, identity, state: () => state };
}

test('Google sign-in binds approved identities and uses a single-use browser flow', async () => {
    using db = openDatabase(':memory:');
    const google = mockGoogle();
    const auth = new AuthService(db, google.provider);
    const user = auth.store.bootstrap(google.identity.email);
    const { flowToken } = auth.beginLogin();
    const attempt = { flowToken, state: google.state(), code: 'ok' };

    assert.equal(await auth.completeLogin({ ...attempt, flowToken: undefined }), undefined);
    assert.equal(await auth.completeLogin({ ...attempt, state: flowToken }), undefined);
    const first = await auth.completeLogin(attempt);
    assert.ok(first);
    assert.deepEqual(auth.session(first.token)?.user, user);
    assert.equal(await auth.completeLogin(attempt), undefined);
    assert.notEqual(db.prepare('SELECT token_hash FROM sessions').get()?.token_hash, first.token);

    const signIn = (code = 'ok') => auth.completeLogin({ flowToken: auth.beginLogin().flowToken, state: google.state(), code });
    assert.equal(await signIn('missing-nonce'), undefined);
    google.identity.subject = 'different-google-account';
    assert.equal(await signIn(), undefined, 'the same email cannot replace a bound subject');
    google.identity.subject = 'google-account-1';
    google.identity.email = 'renamed@gmail.com';
    const renamed = await signIn();
    assert.deepEqual(renamed?.user, user, 'an email rename preserves the Google subject mapping');
    auth.logout(first.token);
    assert.equal(auth.session(first.token), undefined);
    assert.equal(auth.store.listAudit()[0]?.action, 'auth.sign_out');
});

test('Google sign-in rejects unapproved, disabled, expired, and unverifiable identities', async () => {
    using db = openDatabase(':memory:');
    const google = mockGoogle();
    let now = Date.now();
    const auth = new AuthService(db, google.provider, () => now);
    auth.store.bootstrap('admin@gmail.com');
    const signIn = () => auth.completeLogin({ flowToken: auth.beginLogin().flowToken, state: google.state(), code: 'ok' });
    assert.equal(await signIn(), undefined);
    const user = auth.store.allowUser(google.identity.email, 'operator');
    google.identity.emailVerified = false;
    assert.equal(await signIn(), undefined);
    google.identity.emailVerified = true;
    google.identity.email = 'external@example.test';
    auth.store.allowUser(google.identity.email, 'operator');
    assert.equal(await signIn(), undefined, 'unhosted third-party email is insufficient to bind an invitation');
    google.identity.email = user.email;

    const flow = auth.beginLogin();
    now = flow.expiresAt;
    assert.equal(await auth.completeLogin({ flowToken: flow.flowToken, state: google.state(), code: 'ok' }), undefined);
    const session = await signIn();
    assert.ok(session);
    now = session.expiresAt;
    assert.equal(auth.session(session.token), undefined);
    const active = await signIn();
    assert.ok(active);
    auth.store.setUserEnabled(user.id, false);
    assert.equal(auth.session(active.token), undefined);
    assert.equal(await signIn(), undefined);
    const page = auth.store.listAudit(undefined, 2);
    assert.deepEqual(page.map(event => event.action), ['auth.sign_in', 'user.disable']);
    assert.ok(auth.store.listAudit(page[1]!.id).every(event => event.id < page[1]!.id));
});

test('SQLite backup restores approved users and audit history with explicit session revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-auth-'));
    try {
        using db = openDatabase(join(directory, 'original.sqlite'));
        const google = mockGoogle();
        const auth = new AuthService(db, google.provider);
        const admin = auth.store.bootstrap(google.identity.email);
        const flow = auth.beginLogin();
        const session = await auth.completeLogin({ flowToken: flow.flowToken, state: google.state(), code: 'ok' });
        assert.ok(session);
        assert.throws(() => auth.store.setUserEnabled(admin.id, false), /At least one administrator/);
        const path = join(directory, 'backup.sqlite');
        await backupDatabase(db, path);
        using restored = openDatabase(path);
        const store = new AuthStore(restored);
        assert.deepEqual(store.listUsers(), [admin]);
        assert.equal(store.listAudit()[0]?.action, 'auth.sign_in');
        assert.equal(store.revokeAllSessions(), 1);
        assert.equal(new AuthService(restored, google.provider).session(session.token), undefined);
        assert.ok(store.prune(Date.now() + 91 * 86_400_000).events >= 3);
        assert.equal(store.listAudit().length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('Google provider requests identity scopes and uses PKCE S256', () => {
    const provider = createGoogleProvider({ clientId: 'test-id', clientSecret: 'test-secret', redirectUri: 'https://dashboard.example.test/auth/callback' });
    const url = new URL(provider.authorize({ state: 'state', nonce: 'nonce', challenge: 'challenge' }));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'openid email');
    assert.equal(url.searchParams.get('state'), 'state');
    assert.equal(url.searchParams.get('nonce'), 'nonce');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge');
    assert.ok(!url.searchParams.has('client_secret'));
});
