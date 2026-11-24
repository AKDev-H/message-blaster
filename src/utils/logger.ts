import { closeSync, constants, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import type { Environment } from '../config/env.js';

const REDACTED_FIELDS = [
    'phone', 'email', 'subject', 'text', 'qr', 'credentials',
    'message.phone', 'message.email', 'message.subject', 'message.text',
];
const APPEND_ONLY = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);

export function createLogger(env: Environment): Logger {
    const fd = openPrivateLogFile(env.LOG_DIR);
    const options = { level: env.LOG_LEVEL, redact: REDACTED_FIELDS };
    return pino(options, pino.destination({ dest: fd, sync: true }));
}

function openPrivateLogFile(directory: string): number {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(join(directory, 'app.log'), APPEND_ONLY, 0o600);
    restrictToOwner(fd);
    return fd;
}

function restrictToOwner(fd: number): void {
    try {
        fchmodSync(fd, 0o600);
    } catch (error) {
        closeSync(fd);
        throw error;
    }
}
