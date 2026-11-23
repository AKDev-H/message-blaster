import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

export type AttachmentErrorCode = 'UNSAFE_PATH' | 'BLOCKED_TYPE' | 'EMPTY_ATTACHMENT' | 'MISSING_ATTACHMENT' | 'INVALID_PDF'
    | 'UNREADABLE_ATTACHMENT';

/** File types Gmail refuses to send (and that are risky to forward), so they are never accepted as attachments. */
const blockedExtensions = new Set([
    '.ade', '.adp', '.apk', '.appx', '.appxbundle', '.bat', '.cab', '.chm', '.cmd', '.com', '.cpl', '.diagcab', '.diagcfg',
    '.diagpkg', '.dll', '.dmg', '.ex', '.ex_', '.exe', '.hta', '.ins', '.isp', '.iso', '.jar', '.jnlp', '.js', '.jse', '.lib',
    '.lnk', '.mde', '.mjs', '.msc', '.msi', '.msix', '.msixbundle', '.msp', '.mst', '.nsh', '.pif', '.ps1', '.scr', '.sct',
    '.shb', '.sh', '.sys', '.vb', '.vbe', '.vbs', '.vhd', '.vxd', '.wsc', '.wsf', '.wsh', '.xll',
]);

const mimeTypes: Record<string, string> = {
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

export function attachmentMimeType(name: string): string {
    return mimeTypes[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** True for a plain file name with an extension that is not on the blocked list. */
export function isAllowedAttachmentName(name: string): boolean {
    const extension = extname(name).toLowerCase();
    return name.length <= 255 && name === name.trim() && extension.length > 1 && extension !== name.toLowerCase() &&
        !blockedExtensions.has(extension) &&
        // eslint-disable-next-line no-control-regex -- Reject control characters and directory components.
        !/[/\\:\u0000-\u001f\u007f]/u.test(name);
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
    // eslint-disable-next-line no-control-regex -- Reject control characters and directory components.
    if (/[/\\:\u0000-\u001f\u007f]/u.test(name) || name !== name.trim() || !extname(name)) {
        throw new AttachmentError('UNSAFE_PATH', 'Use a file name with an extension and without any folders.');
    }
    if (!isAllowedAttachmentName(name)) {
        throw new AttachmentError('BLOCKED_TYPE', `${extname(name).toLowerCase()} files cannot be sent as attachments.`);
    }

    let data: Buffer;
    try {
        const root = await realpath(directory);
        const path = join(root, name);
        const expected = await lstat(path, { bigint: true });
        if (!expected.isFile()) {
            throw new AttachmentError('UNSAFE_PATH', 'The attachment must be a regular file without symbolic links.');
        }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const actual = await file.stat({ bigint: true });
            if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
                throw new AttachmentError('UNSAFE_PATH', 'The attachment changed while opening it.');
            }
            data = await file.readFile();
        } finally {
            await file.close();
        }
    } catch (error) {
        if (error instanceof AttachmentError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new AttachmentError('MISSING_ATTACHMENT', 'Attachment was not found.', { cause: error });
        }
        if (code === 'ELOOP' || code === 'EMLINK') {
            throw new AttachmentError('UNSAFE_PATH', 'Symbolic links cannot be used as attachments.', { cause: error });
        }
        throw new AttachmentError('UNREADABLE_ATTACHMENT', 'The attachment could not be read.', { cause: error });
    }

    if (!data.length) throw new AttachmentError('EMPTY_ATTACHMENT', 'The attachment is empty.');
    if (extname(name).toLowerCase() === '.pdf') await validatePdf(data);
    return { name, data, sha256: createHash('sha256').update(data).digest('hex') };
}

/** PDFs get a structural check because a corrupt PDF is a common, silent delivery failure. */
async function validatePdf(data: Buffer): Promise<void> {
    const header = data.subarray(0, 10).toString('latin1');
    const eof = data.lastIndexOf('%%EOF');
    if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/u.test(header) || eof < 0 || data.subarray(eof + 5).toString('latin1').trim()) {
        throw new AttachmentError('INVALID_PDF', 'The PDF is missing required file markers.');
    }
    try {
        const pdf = await PDFDocument.load(data, { throwOnInvalidObject: true, updateMetadata: false });
        if (pdf.getPageCount() === 0) throw new Error('The PDF has no pages.');
    } catch (error) {
        throw new AttachmentError('INVALID_PDF', 'The PDF is corrupted, encrypted, or has no pages.', { cause: error });
    }
}
