export interface ControlOptions {
    extended?: boolean;
    keep?: string;
}

export function isControlCharacter(character: string, { extended = false, keep = '' }: ControlOptions = {}): boolean {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || (extended && code >= 0x80 && code <= 0x9f);
    return control && !keep.includes(character);
}

export function hasControlCharacters(text: string, options?: ControlOptions): boolean {
    return [...text].some(character => isControlCharacter(character, options));
}

export function replaceControlCharacters(text: string, replacement: string, options?: ControlOptions): string {
    let result = '';
    let inRun = false;
    for (const character of text) {
        const control = isControlCharacter(character, options);
        if (!control) result += character;
        else if (!inRun) result += replacement;
        inRun = control;
    }
    return result;
}
