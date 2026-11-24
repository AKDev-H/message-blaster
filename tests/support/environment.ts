import { join } from 'node:path';
import { DEFAULT_SETTINGS, loadEnv, type BaseEnvironment, type Environment } from '../../src/config/env.js';

export function testEnvironment(directory: string, overrides: Partial<Environment> = {}): Environment {
    const base: BaseEnvironment = loadEnv();
    return {
        ...base, ...DEFAULT_SETTINGS,
        DATABASE_URL: join(directory, 'app.db'), ATTACHMENTS_DIR: join(directory, 'attachments'), LOG_DIR: join(directory, 'logs'),
        APPROVED_ACCOUNTS: [], DRY_RUN: true, MAINTENANCE_MODE: false,
        ...overrides,
    };
}
