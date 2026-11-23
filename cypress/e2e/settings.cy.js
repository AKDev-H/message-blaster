// WhatsApp pairing and the Gmail connection check reach external services, so those requests are stubbed.
const settingsWith = whatsapp => ({
    gmail: { user: '', passwordSet: false },
    whatsapp,
    sending: { country: 'MY', delaySeconds: 10 },
    countries: ['MY', 'SG'],
});
const qr = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=';

describe('Settings', () => {
    beforeEach(() => {
        cy.openDashboard();
        cy.get('#open-settings').click();
        cy.get('#settings').should('be.visible');
    });

    it('validates and saves the Gmail sender without echoing the App Password', () => {
        cy.get('#gmail-save').click();
        cy.get('#gmailUser-error').should('have.text', 'Enter the Gmail address you send from.');
        cy.get('#gmailPassword-error').should('have.text', 'Enter the 16-character App Password.');

        cy.get('#gmail-user').type('sender@gmail.com');
        cy.get('#gmail-password').type('too short');
        cy.get('#gmail-save').click();
        cy.get('#gmailPassword-error').should('have.text', 'An App Password has 16 letters and numbers.');

        cy.intercept('PUT', '/api/settings/gmail').as('save');
        cy.get('#gmail-password').clear().type('abcd efgh ijkl mnop');
        cy.get('#gmail-save').click();
        cy.wait('@save').its('response.body').should(body => {
            expect(body.gmail).to.deep.equal({ user: 'sender@gmail.com', passwordSet: true });
            expect(JSON.stringify(body)).not.to.contain('abcdefghijklmnop');
        });
        cy.contains('#toast', 'Gmail settings saved');
        cy.get('#gmail-password').should('have.value', '').and('have.attr', 'placeholder', 'Saved. Leave blank to keep it.');

        cy.get('#settings [data-close]').click();
        cy.get('#open-settings').click();
        cy.get('#gmail-user').should('have.value', 'sender@gmail.com');
        cy.get('#gmail-user').clear().type('team@gmail.com');
        cy.get('#gmail-save').click();
        cy.contains('#toast', 'Gmail settings saved');
        cy.request('/api/settings').its('body.gmail').should('deep.equal', { user: 'team@gmail.com', passwordSet: true });
    });

    it('checks the Gmail connection and reports failures', () => {
        cy.get('#gmail-verify').should('be.disabled');
        cy.get('#gmail-user').type('sender@gmail.com');
        cy.get('#gmail-password').type('abcdefghijklmnop');
        cy.get('#gmail-save').click();
        cy.get('#gmail-verify').should('not.be.disabled');

        cy.intercept('POST', '/api/settings/gmail/verify', { statusCode: 502, body: { error: 'Gmail rejected SMTP authentication. Check GMAIL_USER and GMAIL_APP_PASSWORD.' } });
        cy.get('#gmail-verify').click();
        cy.get('#gmail-error').should('contain', 'Gmail rejected SMTP authentication');

        cy.intercept('POST', '/api/settings/gmail/verify', { body: { ok: true } });
        cy.get('#gmail-verify').click();
        cy.get('#gmail-status').should('be.visible').and('contain', 'Gmail accepted these details.');
        cy.get('#gmail-error').should('not.be.visible');
    });

    it('saves the sending country and pause between messages', () => {
        cy.get('#tab-sending').click();
        cy.get('#panel-sending').should('be.visible');
        cy.get('#panel-gmail').should('not.be.visible');
        cy.get('#sending-country').should('have.value', 'MY');
        cy.get('#sending-delay').clear();
        cy.get('#sending-save').click();
        cy.get('#delay-error').should('have.text', 'Use 0–3,600 seconds.');

        cy.get('#sending-country').select('SG');
        cy.get('#sending-delay').type('4');
        cy.get('#sending-save').click();
        cy.contains('#toast', 'Sending settings saved');
        cy.request('/api/settings').its('body.sending').should('deep.equal', { country: 'SG', delaySeconds: 4 });
    });

    it('uses the saved country when importing local phone numbers', () => {
        cy.get('#tab-sending').click();
        cy.get('#sending-country').select('SG');
        cy.get('#sending-save').click();
        cy.contains('#toast', 'Sending settings saved');
        cy.get('#settings [data-close]').click();
        cy.importCampaign({
            name: 'local-numbers',
            channels: ['whatsapp'],
            channel: 'whatsapp',
            rows: [{ 'Client ID': 'C1', 'Client Name': 'Ari', 'Phone Number': '81234567', 'Consent Status': 'Opted In' }],
        });
        cy.get('#detail-rows').should('contain', '+6581234567');
    });

    it('links WhatsApp with a QR code, then unlinks it', () => {
        cy.get('#tab-whatsapp').click();
        cy.get('#whatsapp-state').should('have.text', 'Not linked');
        cy.get('#whatsapp-unlink').should('not.be.visible');

        cy.intercept('POST', '/api/settings/whatsapp/link', { body: settingsWith({ status: 'pairing', qr }) }).as('link');
        cy.intercept('GET', '/api/settings', { body: settingsWith({ status: 'linked', account: '+60123456789' }) }).as('poll');
        cy.get('#whatsapp-link').click();
        cy.wait('@link');
        cy.get('#whatsapp-state').should('have.text', 'Waiting for your phone');
        cy.get('#whatsapp-qr-image').should('be.visible').and('have.attr', 'src', qr);
        cy.get('#whatsapp-cancel').should('be.visible');

        cy.wait('@poll');
        cy.get('#whatsapp-state').should('have.text', 'Linked to +60123456789');
        cy.get('#whatsapp-status').should('have.attr', 'data-status', 'linked');
        cy.get('#whatsapp-qr').should('not.be.visible');

        cy.intercept('POST', '/api/settings/whatsapp/unlink', { body: settingsWith({ status: 'unlinked' }) });
        cy.get('#whatsapp-unlink').click();
        cy.contains('#toast', 'WhatsApp unlinked');
        cy.get('#whatsapp-state').should('have.text', 'Not linked');
    });

    it('cancels pairing and shows linking errors', () => {
        cy.get('#tab-whatsapp').click();
        cy.intercept('POST', '/api/settings/whatsapp/link', { body: settingsWith({ status: 'pairing' }) });
        cy.intercept('GET', '/api/settings', { body: settingsWith({ status: 'pairing' }) });
        cy.get('#whatsapp-link').click();
        cy.get('#whatsapp-qr-wait').should('be.visible');

        cy.intercept('DELETE', '/api/settings/whatsapp/link', {
            body: settingsWith({ status: 'unlinked', error: 'WhatsApp QR pairing timed out. Run whatsapp:connect again.' }),
        });
        cy.get('#whatsapp-cancel').click();
        cy.get('#whatsapp-state').should('have.text', 'Not linked');
        cy.get('#whatsapp-error').should('contain', 'pairing timed out');
    });

    it('moves between tabs with the arrow keys', () => {
        cy.get('#tab-gmail').focus().type('{rightArrow}');
        cy.get('#tab-whatsapp').should('have.attr', 'aria-selected', 'true').and('be.focused');
        cy.get('#tab-whatsapp').type('{rightArrow}');
        cy.get('#tab-sending').should('have.attr', 'aria-selected', 'true');
    });
});
