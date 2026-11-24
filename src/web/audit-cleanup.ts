import type { AuthStore } from '../auth/store.js';

export const AUDIT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;


export function scheduleAuditCleanup(store: AuthStore, now = Date.now, intervalMs = DAY_MS): { stop(): void } {
    const run = () => {
        try {
            const { events } = store.prune(now(), AUDIT_RETENTION_DAYS);
            if (events) console.log(`Audit cleanup removed ${events} event${events === 1 ? '' : 's'} older than ${AUDIT_RETENTION_DAYS} days`);
        } catch (error) {
            console.error('Audit cleanup failed', error instanceof Error ? error.message : error);
        }
    };
    run();
    const timer = setInterval(run, intervalMs).unref();
    return { stop: () => clearInterval(timer) };
}
