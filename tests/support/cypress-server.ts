import { resolve } from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { startWebServer } from '../../src/web/server.js';
import { approveTestUser, mockGoogle } from './web-auth.js';

if (!process.env.DATABASE_URL || resolve(process.env.DATABASE_URL) !== resolve('storage/cypress/cypress.db')
    || process.env.WEB_PORT !== '4319') throw new Error('Use npm run cy:server to start the isolated Cypress fixture.');
const env = {
    ...loadEnv(),
    ATTACHMENTS_DIR: resolve('storage/cypress/attachments'),
    AUTH_DIR: resolve('storage/cypress/auth'),
    LOG_DIR: resolve('storage/cypress/logs'),
    SECRET_KEY_FILE: resolve('storage/cypress/secret.key'),
    DRY_RUN: true,
    MAINTENANCE_MODE: false,
    APPROVED_ACCOUNTS: [],
};
approveTestUser(env.DATABASE_URL);
const dashboard = await startWebServer(env, env.WEB_PORT, {
    origin: `http://127.0.0.1:${env.WEB_PORT}`,
    provider: mockGoogle(),
});
console.log(`Cypress dashboard · ${dashboard.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void dashboard.close());
