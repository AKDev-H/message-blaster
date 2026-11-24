const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\{|\}\}/g;

export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(PLACEHOLDER, (_, key: string | undefined) => placeholderValue(key, values));
}

function placeholderValue(key: string | undefined, values: Readonly<Record<string, string>>): string {
    if (key === undefined) throw new Error('Malformed message placeholder.');
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown message placeholder: ${key}.`);
    return values[key]!;
}
