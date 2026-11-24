import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hasErrorCode } from '../../utils/fs.util.js';

export async function publishWorkbook(data: Buffer, path: string): Promise<boolean> {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(dirname(target), '.workbook-'));
    try {
        return await linkNewFile(join(temporary, 'workbook.xlsx'), data, target);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

async function linkNewFile(file: string, data: Buffer, target: string): Promise<boolean> {
    await writeFile(file, data, { flag: 'wx', mode: 0o600 });
    try {
        await link(file, target);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) return false;
        throw error;
    }
}
