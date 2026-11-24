import { setTimeout as sleep } from 'node:timers/promises';

export function watchShutdown() {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return {
        signal: controller.signal,
        [Symbol.dispose]() {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
        },
    };
}

export async function wait(ms: number, signal: AbortSignal): Promise<void> {
    if (!ms || signal.aborted) return;
    try {
        await sleep(ms, undefined, { signal });
    } catch (error) {
        if (!signal.aborted) throw error;
    }
}
