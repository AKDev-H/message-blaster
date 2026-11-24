import { replaceControlCharacters } from './text.util.js';

export function terminalText(text: string): string {
    return replaceControlCharacters(text, '', { extended: true, keep: '\t\n' });
}
