import { config } from 'dotenv';
import { isSupportedCountry, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

const integer = (min: number, max: number, fallback: number) =>
    z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().min(min).max(max))
        .default(fallback);
const boolean = (fallback: boolean) =>
    z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .default(fallback);
const localPath = (fallback: string) =>
    z
        .string()
        .trim()
        .min(1)
        .refine(
            (path) =>
                path !== ':memory:' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path),
            'Use a local filesystem path',
        )
        .default(fallback);

const schema = z.object({
    NODE_ENV: z
        .enum(['development', 'test', 'production'])
        .default('development'),
    DATABASE_URL: localPath('./storage/app.db'),
    GMAIL_EXCEL_FILE: localPath('./data/gmail-clients.xlsx'),
    GMAIL_USER: z.string().default(''),
    GMAIL_APP_PASSWORD: z.string().default(''),
    GROQ_API_KEY: z.string().trim().default(''),
    GROQ_MODEL: z.string().trim().min(1).default('openai/gpt-oss-120b'),
    EXCEL_FILE: localPath('./data/clients.xlsx'),
    ATTACHMENTS_DIR: localPath('./storage/attachments'),
    AUTH_DIR: localPath('./auth'),
    LOG_DIR: localPath('./logs'),
    DEFAULT_COUNTRY: z
        .string()
        .trim()
        .toUpperCase()
        .refine(isSupportedCountry, 'Unsupported country code')
        .transform((value) => value as CountryCode)
        .default('MY'),
    MAX_MESSAGES_PER_RUN: integer(1, 5_000, 100),
    MESSAGE_DELAY_MS: integer(0, 3_600_000, 10_000),
    MAX_RETRY_ATTEMPTS: integer(0, 10, 3),
    SENDER_CONCURRENCY: integer(1, 10, 1),
    RETRY_DELAY_MS: integer(100, 3_600_000, 5_000),
    RECEIPT_WAIT_MS: integer(0, 300_000, 5_000),
    WEB_PORT: integer(1, 65_535, 3_000),
    DRY_RUN: boolean(true),
    REQUIRE_MANUAL_APPROVAL: z.literal('true').default('true'),
    LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
});

export type Environment = z.output<typeof schema>;

export function loadEnv(): Environment {
    config({ quiet: true });
    const result = schema.safeParse(process.env);
    if (!result.success) {
        throw new Error(
            result.error.issues
                .map((issue) => `${issue.path.join('.')} — ${issue.message}`)
                .join('\n'),
        );
    }
    return result.data;
}
