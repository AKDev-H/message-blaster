import { link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachmentError, isAllowedAttachmentName, readAttachment } from '../../services/attachment.service.js';
import { hasErrorCode } from '../../utils/fs.util.js';
import { HttpError } from '../http-error.js';
import { MAX_FILE_BYTES } from './body.js';

export interface AttachmentListing {
    name: string;
    size: number;
}

export async function listAttachments(directory: string): Promise<AttachmentListing[]> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const names = entries.filter(entry => entry.isFile() && isListable(entry.name)).map(entry => entry.name);
        return await withSizes(directory, names.sort((a, b) => a.localeCompare(b)));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
}

export async function storeAttachment(directory: string, form: FormData): Promise<string> {
    const upload = uploadedFile(form);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, '.upload-'));
    try {
        await checkAndMove(upload, temporary, directory);
        return upload.name;
    } catch (error) {
        throw uploadError(error);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

function isListable(name: string): boolean {
    return !name.startsWith('.') && isAllowedAttachmentName(name);
}

async function withSizes(directory: string, names: string[]): Promise<AttachmentListing[]> {
    const files: AttachmentListing[] = [];
    for (const name of names) {
        const info = await stat(join(directory, name)).catch(() => undefined);
        if (info?.isFile()) files.push({ name, size: info.size });
    }
    return files;
}

function uploadedFile(form: FormData): File {
    const upload = form.get('file');
    if (!upload || typeof upload === 'string' || !upload.size) throw new HttpError(400, 'Choose a file to upload.');
    if (upload.size > MAX_FILE_BYTES) throw new HttpError(413, 'Each upload can be up to 10 MB.');
    if (!isAllowedAttachmentName(upload.name)) throw new HttpError(400, 'This file type can’t be sent. Choose a document, image, or other common file.');
    return upload;
}

async function checkAndMove(upload: File, temporary: string, directory: string): Promise<void> {
    const source = join(temporary, upload.name);
    await writeFile(source, Buffer.from(await upload.arrayBuffer()), { flag: 'wx', mode: 0o600 });
    await readAttachment(temporary, upload.name);
    await link(source, join(directory, upload.name));
}

function uploadError(error: unknown): unknown {
    if (error instanceof AttachmentError) return new HttpError(400, error.message);
    if (hasErrorCode(error, 'EEXIST')) return new HttpError(409, 'A file already uses that name. Rename the upload to keep both versions.');
    return error;
}
