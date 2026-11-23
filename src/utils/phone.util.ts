import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export function normalizePhone(input: string, country: CountryCode): string {
    const number = parsePhoneNumberFromString(input.trim(), { defaultCountry: country, extract: false });
    if (!number?.isValid() || number.ext !== undefined) {
        throw new Error('Invalid phone number. Use a local number or international format with a leading +.');
    }
    return number.number;
}
