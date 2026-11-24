import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthStore } from '../../auth/store.js';
import { transaction } from '../../database/transaction.js';

type Outcome = 'success' | 'failed' | 'accepted' | 'denied';

export class RequestAudit {
    #requestId: string | undefined;

    constructor(private readonly db: DatabaseSync, private readonly store: AuthStore, private readonly actorId: number) {}

    record(action: string, outcome: Outcome, target?: string, source: 'web' | 'worker' = 'web'): void {
        this.#requestId ??= randomUUID();
        this.store.audit({ actorId: this.actorId, source, action, outcome, requestId: this.#requestId, ...(target === undefined ? {} : { target }) });
    }

    mutation<T>(action: string, operation: () => T, target?: string): T {
        try {
            return transaction(this.db, () => {
                const result = operation();
                this.record(action, 'success', target);
                return result;
            });
        } catch (error) {
            this.failed(action, target);
            throw error;
        }
    }

    async effect<T>(action: string, operation: () => T | Promise<T>): Promise<T> {
        this.record(action, 'accepted');
        try {
            const result = await operation();
            this.record(action, 'success');
            return result;
        } catch (error) {
            this.failed(action);
            throw error;
        }
    }

    private failed(action: string, target?: string): void {
        try {
            this.record(action, 'failed', target);
        } catch {
            console.error('Could not record the failed dashboard action');
        }
    }
}
