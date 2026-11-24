export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code !== undefined && codes.includes(code);
}

export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}
