import { get, sendJson, setError, toast, whileBusy } from '../shared/ui.mjs';

const STATUS_COPY = {
    unlinked: () => ['Not linked', 'Link the phone number you send campaigns from.'],
    pairing: () => ['Waiting for your phone', 'In WhatsApp, open Settings › Linked devices › Link a device, then scan this code.'],
    linked: account => [`Linked to ${account ?? 'your number'}`, 'Campaigns send from this number.'],
    loggedOut: () => ['Logged out on the phone', 'Unlink this session, then link the number again.'],
};

const LINK_BUTTONS = [
    ['whatsapp-link', '/api/settings/whatsapp/link', 'POST'],
    ['whatsapp-cancel', '/api/settings/whatsapp/link', 'DELETE'],
    ['whatsapp-unlink', '/api/settings/whatsapp/unlink', 'POST'],
];

/** The WhatsApp tab: link status, the pairing QR code, and the link / cancel / unlink buttons. */
export class WhatsAppPanel {
    constructor(onChange) {
        for (const [id, path, method] of LINK_BUTTONS) {
            get(id).addEventListener('click', event => whileBusy(event.currentTarget, () => this.#call(id, path, method, onChange)));
        }
    }

    render({ status, account, qr, error }) {
        const [state, copy] = STATUS_COPY[status](account);
        get('whatsapp-status').dataset.status = status;
        get('whatsapp-state').textContent = state;
        get('whatsapp-copy').textContent = copy;
        showQrCode(status, qr);
        showButtons(status);
        setError('whatsapp-error', error ?? '');
    }

    async #call(id, path, method, onChange) {
        setError('whatsapp-error', '');
        try {
            onChange(await sendJson(path, method));
            if (id === 'whatsapp-unlink') toast('WhatsApp unlinked');
        } catch (error) {
            setError('whatsapp-error', error);
        }
    }
}

/** While pairing, shows a waiting message until the QR code arrives. */
function showQrCode(status, qr) {
    get('whatsapp-qr').hidden = status !== 'pairing';
    get('whatsapp-qr-wait').hidden = Boolean(qr);
    const image = get('whatsapp-qr-image');
    image.hidden = !qr;
    if (qr && image.getAttribute('src') !== qr) image.src = qr;
}

function showButtons(status) {
    get('whatsapp-link').hidden = status !== 'unlinked';
    get('whatsapp-cancel').hidden = status !== 'pairing';
    get('whatsapp-unlink').hidden = status !== 'linked' && status !== 'loggedOut';
}
