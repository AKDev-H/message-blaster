import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

export interface AppSettings {
    GMAIL_USER: string;
    GMAIL_APP_PASSWORD: string;
    DEFAULT_COUNTRY: CountryCode;
    MESSAGE_DELAY_MS: number;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
    GMAIL_USER: '',
    GMAIL_APP_PASSWORD: '',
    DEFAULT_COUNTRY: 'MY',
    MESSAGE_DELAY_MS: 10_000,
};

const configDir = () => process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
const isUrl = (path: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
const isLocalPath = (path: string) => path !== ':memory:' && !isUrl(path);
const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

const integer = (min: number, max: number, fallback: number) =>
    z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max)).default(fallback);

const boolean = (fallback: boolean) =>
    z.enum(['true', 'false']).transform(value => value === 'true').default(fallback);

const localPath = (fallback: string) =>
    z.string().trim().min(1).refine(isLocalPath, 'Use a local filesystem path').transform(expandHome).default(fallback);

const schema = z.object({
    DATABASE_URL: localPath('./storage/app.db'),
    SECRET_KEY_FILE: localPath(join(configDir(), 'message-blaster', 'secret.key')),
    GMAIL_EXCEL_FILE: localPath('./data/gmail-clients.xlsx'),
    GROQ_API_KEY: z.string().trim().default(''),
    GROQ_MODEL: z.string().trim().min(1).default('openai/gpt-oss-120b'),
    EXCEL_FILE: localPath('./data/clients.xlsx'),
    ATTACHMENTS_DIR: localPath('./storage/attachments'),
    AUTH_DIR: localPath('./auth'),
    LOG_DIR: localPath('./logs'),
    MAX_MESSAGES_PER_RUN: integer(1, 5_000, 100),
    MAX_RETRY_ATTEMPTS: integer(0, 10, 3),
    SENDER_CONCURRENCY: integer(1, 10, 1),
    RETRY_DELAY_MS: integer(100, 3_600_000, 5_000),
    RECEIPT_WAIT_MS: integer(0, 300_000, 5_000),
    WEB_PORT: integer(1, 65_535, 3_000),
    DRY_RUN: boolean(true),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BaseEnvironment = z.output<typeof schema>;
export type Environment = BaseEnvironment & AppSettings;

export function loadEnv(): BaseEnvironment {
    config({ quiet: true });
    const result = schema.safeParse(process.env);
    if (!result.success) throw new Error(describeIssues(result.error.issues));
    return result.data;
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
    return issues.map(issue => `${issue.path.join('.')} — ${issue.message}`).join('\n');
}
