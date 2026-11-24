import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inlineIcons } from '../src/web/inline-icons.js';
import { startWebServer } from '../src/web/server.js';
import { testEnvironment } from './support/environment.js';
import { approveTestUser, authenticatedFetch, mockGoogle, testLogin } from './support/web-auth.js';

test('icon placeholders are rendered to SVG on the server', () => {
    const html = inlineIcons('<b><i data-icon="plus"></i><i data-icon="chevron-down" data-size="14"></i></b>');
    assert.doesNotMatch(html, /data-icon/u);
    assert.match(html, /<svg class="icon icon-plus" width="16" height="16"[^>]*><path d="M5 12h14"\/><path d="M12 5v14"\/><\/svg>/u);
    assert.match(html, /<svg class="icon icon-chevron-down" width="14" height="14"/u);
    assert.throws(() => inlineIcons('<i data-icon="no-such-icon"></i>'), /Unknown icon: no-such-icon/u);
});

test('dashboard ships icons inline and revalidates static files with ETags', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-assets-'));
    const env = testEnvironment(directory);
    approveTestUser(env.DATABASE_URL);
    const dashboard = await startWebServer(env, 0, { origin: 'http://127.0.0.1:0', provider: mockGoogle() });
    context.after(async () => {
        await dashboard.close();
        await rm(directory, { recursive: true, force: true });
    });

    const request = authenticatedFetch(dashboard.url, await testLogin(dashboard.url));
    const page = await request('/');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.doesNotMatch(html, /<i data-icon=/u);
    assert.match(html, /<svg class="icon icon-megaphone"/u);

    for (const path of ['/vendor/lucide.js', '/app.mjs', '/fonts/instrument.woff2']) {
        const first = await request(path);
        await first.arrayBuffer();
        const etag = first.headers.get('etag');
        assert.equal(first.headers.get('cache-control'), 'no-cache', path);
        assert.ok(etag, path);
        const repeat = await request(path, { headers: { 'If-None-Match': etag } });
        assert.equal(repeat.status, 304, path);
        const stale = await request(path, { headers: { 'If-None-Match': '"from-an-older-deploy"' } });
        assert.equal(stale.status, 200, path);
        await stale.arrayBuffer();
    }

    const api = await request('/api/campaign-groups');
    await api.arrayBuffer();
    assert.equal(api.headers.get('cache-control'), 'no-store');
});
