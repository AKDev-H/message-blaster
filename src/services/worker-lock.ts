import { realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { WorkerBusyError } from '../errors.js';
import type { Store } from '../store/index.js';

export async function acquireWorkerLock(databasePath: string): Promise<DatabaseSync> {
    const lock = new DatabaseSync(`${await realpath(databasePath)}.worker-lock.sqlite`, { timeout: 0 });
    try {
        lock.exec('BEGIN IMMEDIATE');
        return lock;
    } catch (error) {
        lock.close();
        if (error instanceof Error && /locked|busy/i.test(error.message)) {
            throw new WorkerBusyError('Another live campaign worker already owns this database.', { cause: error });
        }
        throw error;
    }
}

export async function recoverInterruptedCampaigns(store: Store, databasePath: string): Promise<number> {
    using _lock = await acquireWorkerLock(databasePath);
    return store.recover();
}
