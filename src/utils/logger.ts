import { mkdirSync, openSync, closeSync, fchmodSync, constants } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import type { Environment } from '../config/env.js';

export function createLogger(env: Environment): Logger {
    mkdirSync(env.LOG_DIR, { recursive: true, mode: 0o700 });
    const file = join(env.LOG_DIR, 'app.log');
    const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        fchmodSync(fd, 0o600);
    } catch (error) {
        closeSync(fd);
        throw error;
    }
    return pino({
        level: env.LOG_LEVEL,
        redact: ['phone', 'email', 'subject', 'text', 'qr', 'credentials', 'message.phone', 'message.email', 'message.subject', 'message.text'],
    }, pino.destination({ dest: fd, sync: true }));
}
