// eslint-disable-next-line no-control-regex -- Control characters that could rewrite the terminal.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

export function terminalText(text: string): string {
    return text.replace(CONTROL_CHARACTERS, '');
}
