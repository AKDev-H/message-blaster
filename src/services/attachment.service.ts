import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { hasErrorCode } from '../utils/fs.util.js';
import { hasControlCharacters } from '../utils/text.util.js';

export type AttachmentErrorCode = 'UNSAFE_PATH' | 'BLOCKED_TYPE' | 'EMPTY_ATTACHMENT' | 'MISSING_ATTACHMENT' | 'INVALID_PDF'
    | 'UNREADABLE_ATTACHMENT';

const BLOCKED_EXTENSIONS = new Set([
    '.ade', '.adp', '.apk', '.appx', '.appxbundle', '.bat', '.cab', '.chm', '.cmd', '.com', '.cpl', '.diagcab', '.diagcfg',
    '.diagpkg', '.dll', '.dmg', '.ex', '.ex_', '.exe', '.hta', '.ins', '.isp', '.iso', '.jar', '.jnlp', '.js', '.jse', '.lib',
    '.lnk', '.mde', '.mjs', '.msc', '.msi', '.msix', '.msixbundle', '.msp', '.mst', '.nsh', '.pif', '.ps1', '.scr', '.sct',
    '.shb', '.sh', '.sys', '.vb', '.vbe', '.vbs', '.vhd', '.vxd', '.wsc', '.wsf', '.wsh', '.xll',
]);

const MIME_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.zip': 'application/zip',
};

const PATH_CHARACTERS = /[/\\:]/u;
const READ_ONLY_NO_LINKS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function attachmentMimeType(name: string): string {
    return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function isAllowedAttachmentName(name: string): boolean {
    const extension = extname(name).toLowerCase();
    const hasRealExtension = extension.length > 1 && extension !== name.toLowerCase();
    return name.length <= 255 && isPlainFileName(name) && hasRealExtension && !BLOCKED_EXTENSIONS.has(extension);
}

export class AttachmentError extends Error {
    constructor(readonly code: AttachmentErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'AttachmentError';
    }
}

export interface Attachment {
    name: string;
    data: Buffer;
    sha256: string;
}

export async function readAttachment(directory: string, name: string): Promise<Attachment> {
    checkAttachmentName(name);
    const data = await readRegularFile(directory, name);
    if (!data.length) throw new AttachmentError('EMPTY_ATTACHMENT', 'The attachment is empty.');
    if (extname(name).toLowerCase() === '.pdf') await validatePdf(data);
    return { name, data, sha256: createHash('sha256').update(data).digest('hex') };
}

function isPlainFileName(name: string): boolean {
    return name === name.trim() && !PATH_CHARACTERS.test(name) && !hasControlCharacters(name);
}

function checkAttachmentName(name: string): void {
    if (!isPlainFileName(name) || !extname(name)) {
        throw new AttachmentError('UNSAFE_PATH', 'Use a file name with an extension and without any folders.');
    }
    if (!isAllowedAttachmentName(name)) {
        throw new AttachmentError('BLOCKED_TYPE', `${extname(name).toLowerCase()} files cannot be sent as attachments.`);
    }
}

async function readRegularFile(directory: string, name: string): Promise<Buffer> {
    try {
        const path = join(await realpath(directory), name);
        const expected = await lstat(path, { bigint: true });
        if (!expected.isFile()) throw new AttachmentError('UNSAFE_PATH', 'The attachment must be a regular file without symbolic links.');
        return await readUnchangedFile(path, expected);
    } catch (error) {
        throw asAttachmentError(error);
    }
}

async function readUnchangedFile(path: string, expected: { dev: bigint; ino: bigint }): Promise<Buffer> {
    const file: FileHandle = await open(path, READ_ONLY_NO_LINKS);
    try {
        const actual = await file.stat({ bigint: true });
        if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
            throw new AttachmentError('UNSAFE_PATH', 'The attachment changed while opening it.');
        }
        return await file.readFile();
    } finally {
        await file.close();
    }
}

function asAttachmentError(error: unknown): AttachmentError {
    if (error instanceof AttachmentError) return error;
    if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return new AttachmentError('MISSING_ATTACHMENT', 'Attachment was not found.', { cause: error });
    if (hasErrorCode(error, 'ELOOP', 'EMLINK')) {
        return new AttachmentError('UNSAFE_PATH', 'Symbolic links cannot be used as attachments.', { cause: error });
    }
    return new AttachmentError('UNREADABLE_ATTACHMENT', 'The attachment could not be read.', { cause: error });
}

async function validatePdf(data: Buffer): Promise<void> {
    if (!hasPdfMarkers(data)) throw new AttachmentError('INVALID_PDF', 'The PDF is missing required file markers.');
    try {
        const pdf = await PDFDocument.load(data, { throwOnInvalidObject: true, updateMetadata: false });
        if (pdf.getPageCount() === 0) throw new Error('The PDF has no pages.');
    } catch (error) {
        throw new AttachmentError('INVALID_PDF', 'The PDF is corrupted, encrypted, or has no pages.', { cause: error });
    }
}

function hasPdfMarkers(data: Buffer): boolean {
    const header = data.subarray(0, 10).toString('latin1');
    const eof = data.lastIndexOf('%%EOF');
    return /^%PDF-(1\.[0-7]|2\.0)[\r\n]/u.test(header) && eof >= 0 && !data.subarray(eof + 5).toString('latin1').trim();
}
