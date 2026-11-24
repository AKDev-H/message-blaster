import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const keys = new Map<string, Buffer>();

export class SecretError extends Error {}

function readKey(path: string): Buffer {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new SecretError(`The secret key file ${path} is not a valid key.`);
    return key;
}

export function loadSecretKey(file: string): Buffer {
    const path = resolve(file);
    const cached = keys.get(path);
    if (cached) return cached;
    let key: Buffer;
    try {
        key = readKey(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try {
            writeFileSync(path, `${randomBytes(KEY_BYTES).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
        } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
        }
        key = readKey(path);
    }
    keys.set(path, key);
    return key;
}

export const isEncrypted = (value: string) => value.startsWith(PREFIX);

export function encryptSecret(value: string, key: Buffer, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

export function decryptSecret(stored: string, key: Buffer, context: string): string {
    if (!isEncrypted(stored)) throw new SecretError('The value is not encrypted.');
    const payload = Buffer.from(stored.slice(PREFIX.length), 'base64url');
    if (payload.length < IV_BYTES + TAG_BYTES) throw new SecretError('The encrypted value is damaged.');
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES)).setAAD(Buffer.from(context));
        decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
        throw new SecretError('The encrypted value cannot be read with this secret key.');
    }
}
