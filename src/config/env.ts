import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import { normalizeEmail } from '../utils/email.util.js';

export const EMAIL_PROVIDERS = ['gmail', 'smtp'] as const;
export type EmailProvider = typeof EMAIL_PROVIDERS[number];
export const SMTP_SECURITY_MODES = ['tls', 'starttls'] as const;
export type SmtpSecurity = typeof SMTP_SECURITY_MODES[number];

export interface AppSettings {
    EMAIL_PROVIDER: EmailProvider;
    GMAIL_USER: string;
    GMAIL_APP_PASSWORD: string;
    SMTP_HOST: string;
    SMTP_PORT: number;
    SMTP_SECURITY: SmtpSecurity;
    SMTP_USER: string;
    SMTP_PASSWORD: string;
    SMTP_FROM: string;
    SMTP_FROM_NAME: string;
    DEFAULT_COUNTRY: CountryCode;
    MESSAGE_DELAY_MS: number;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
    EMAIL_PROVIDER: 'gmail',
    GMAIL_USER: '',
    GMAIL_APP_PASSWORD: '',
    SMTP_HOST: '',
    SMTP_PORT: 587,
    SMTP_SECURITY: 'starttls',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: '',
    SMTP_FROM_NAME: '',
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

const emailList = () => z.string().default('').transform((value, context) => {
    try {
        return parseEmailList(value);
    } catch (error) {
        context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Use a list of email addresses' });
        return z.NEVER;
    }
});

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
    MAINTENANCE_MODE: boolean(false),
    APPROVED_ACCOUNTS: emailList(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BaseEnvironment = z.output<typeof schema>;
export type Environment = BaseEnvironment & AppSettings;

export function loadEnv(): BaseEnvironment {
    if (process.env.MESSAGE_BLASTER_WORKER !== '1') config({ quiet: true });
    const result = schema.safeParse(process.env);
    if (!result.success) throw new Error(describeIssues(result.error.issues));
    return result.data;
}

export function parseEmailList(value: string): string[] {
    const inner = value.trim().replace(/^\[([\s\S]*)\]$/u, '$1');
    const entries = inner.split(',').map(entry => entry.trim().replace(/^(['"])(.*)\1$/u, '$2').trim()).filter(Boolean);
    return [...new Set(entries.map(entry => {
        try {
            return normalizeEmail(entry);
        } catch {
            throw new Error(`"${entry}" is not an email address`);
        }
    }))];
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
    return issues.map(issue => `${issue.path.join('.')} — ${issue.message}`).join('\n');
}
