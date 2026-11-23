export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\{|\}\}/g, (_, key: string | undefined) => {
        if (key === undefined) throw new Error('Malformed message placeholder.');
        if (!Object.hasOwn(values, key)) throw new Error(`Unknown message placeholder: ${key}.`);
        return values[key]!;
    });
}
