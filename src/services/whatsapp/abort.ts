export function deferred() {
    const result = Promise.withResolvers<void>();
    void result.promise.catch(() => {});
    return result;
}

export async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const handleAbort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', handleAbort, { once: true });
    try {
        return await Promise.race([operation, aborted.promise]);
    } finally {
        signal.removeEventListener('abort', handleAbort);
    }
}

export function asError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback);
}
