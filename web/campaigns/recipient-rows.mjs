import { renderRichText } from '../editor/rich-text.mjs';
import { button, element, number } from '../shared/ui.mjs';
import { badge, RECIPIENT_STATUS_LABELS } from './status.mjs';

/**
 * One table row per recipient. `opened` holds the message previews the user had expanded,
 * so a refresh keeps them open. `on` has `review(recordId)` and `viewAttachment(name)`.
 */
export function recipientRow(record, opened, on) {
    const row = element('tr');
    row.append(identityCell(record), messageCell(record, opened, on), statusCell(record, on),
        element('td', 'muted', number.format(record.attemptCount)));
    return row;
}

export function emptyRecipientRow() {
    const cell = element('td', 'muted', 'No recipients.');
    cell.colSpan = 4;
    const row = element('tr');
    row.append(cell);
    return row;
}

function identityCell(record) {
    const cell = element('td');
    cell.append(
        element('strong', 'block', record.clientName || `Row ${record.rowNumber}`),
        element('span', 'muted block', record.email || record.phone || 'No valid address'),
    );
    return cell;
}

function messageCell(record, opened, on) {
    const cell = element('td', 'message-preview');
    if (record.subject) cell.append(element('strong', 'block', record.subject));
    if (record.message) cell.append(messageBody(record, opened.has(String(record.id))));
    if (record.pdfFilename) cell.append(attachmentButton(record.pdfFilename, on));
    if (!cell.childNodes.length) cell.textContent = '—';
    return cell;
}

/** A one-line summary that expands to the full (formatted) message. */
function messageBody(record, open) {
    const body = element('details', 'message-body');
    body.dataset.record = String(record.id);
    body.open = open;
    const full = element('div', 'message-rich');
    if (record.messageHtml) renderRichText(full, record.messageHtml);
    else showPlainText(full, record.message);
    body.append(element('summary', '', record.message.replaceAll(/\s+/gu, ' ').trim()), full);
    return body;
}

function showPlainText(target, text) {
    target.classList.add('plain');
    target.textContent = text;
}

function attachmentButton(name, on) {
    const file = button(name, () => on.viewAttachment(name), 'file-pill', 'paperclip');
    file.title = `View ${name}`;
    return file;
}

function statusCell(record, on) {
    const cell = element('td', 'recipient-status');
    cell.append(badge(RECIPIENT_STATUS_LABELS[record.status] ?? record.status));
    if (record.errorMessage) cell.append(element('span', 'muted block', record.errorMessage));
    if (record.status === 'UNKNOWN') cell.append(button('Review', () => on.review(record.id), undefined, 'clipboard-check'));
    return cell;
}
