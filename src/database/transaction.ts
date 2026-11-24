import type { DatabaseSync } from 'node:sqlite';

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
    const nested = db.isTransaction;
    db.exec(nested ? 'SAVEPOINT app_transaction' : 'BEGIN IMMEDIATE');
    try {
        const result = operation();
        db.exec(nested ? 'RELEASE app_transaction' : 'COMMIT');
        return result;
    } catch (error) {
        db.exec(nested ? 'ROLLBACK TO app_transaction; RELEASE app_transaction' : 'ROLLBACK');
        throw error;
    }
}
