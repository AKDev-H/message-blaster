const VARIABLE_LABELS = {
    client_name: 'Client name', email_address: 'Email address',
    phone_number: 'Phone number', campaign_id: 'Campaign name', pdf_filename: 'Attachment name',
};
const VARIABLES_BY_CHANNEL = {
    gmail: ['client_name', 'email_address', 'campaign_id', 'pdf_filename'],
    whatsapp: ['client_name', 'phone_number', 'campaign_id', 'pdf_filename'],
};

export function sharedVariables(channels) {
    if (!channels.length) return [];
    return VARIABLES_BY_CHANNEL[channels[0]].filter(token => channels.every(channel => VARIABLES_BY_CHANNEL[channel].includes(token)));
}

export function variableOptions(channels) {
    return sharedVariables(channels).map(token => ({ token, label: VARIABLE_LABELS[token] }));
}

export function campaignNames(name, channels) {
    return channels.length > 1 ? channels.map(channel => `${name}-${channel}`) : [name];
}
