const optedIn = { 'Consent Status': 'Opted In' };

describe('Campaign dialog', () => {
    beforeEach(() => {
        cy.openDashboard();
        cy.openComposer();
    });

    it('lays out settings and the fallback message in two columns', () => {
        cy.get('.compose-settings').then(([settings]) => {
            cy.get('.compose-message').then(([message]) => {
                expect(message.getBoundingClientRect().left).to.be.greaterThan(settings.getBoundingClientRect().right);
            });
        });
        cy.get('.compose-message').should('contain', 'Fallback subject').and('contain', 'Fallback message');
    });

    it('validates required fields next to each control', () => {
        cy.get('#compose-submit').click();
        cy.get('#id-error').should('have.text', 'Enter a campaign name.');
        cy.get('#workbook-error').should('have.text', 'Choose a workbook.');
        cy.get('#campaign-name').should('have.attr', 'aria-invalid', 'true').and('be.focused');

        cy.chooseChannels([]);
        cy.get('#campaign-name').type('x');
        cy.get('#compose-submit').click();
        cy.get('#channel-error').should('have.text', 'Choose at least one channel.');
    });

    it('rejects fields that a selected channel cannot fill', () => {
        cy.typeMessage('Call {{phone_number}}');
        cy.get('#campaign-name').type('fields');
        cy.get('#compose-submit').click();
        cy.get('#script-error').should('contain', '“phone_number” isn’t available for Gmail.');
    });

    it('counts words and characters', () => {
        cy.typeMessage('Hello there friend');
        cy.get('#script-count').should('have.text', '3 words · 18 characters');
    });

    it('opens the field menu on {{ and inserts the chosen field', () => {
        cy.typeMessage('Hi {{cl');
        cy.get('#mention-menu').should('be.visible').find('[role="option"]').should('have.length', 1)
            .first().should('have.attr', 'aria-selected', 'true').and('contain', 'Client name');
        cy.get('#script-editor').type('{enter}');
        cy.get('#mention-menu').should('not.be.visible');
        cy.get('#script-editor').should('contain.text', 'Hi {{client_name}}');

        cy.get('#script-editor').type(' and {{', { parseSpecialCharSequences: false });
        cy.get('#mention-menu [role="option"]').should('have.length', 4);
        cy.get('#mention-menu').contains('[role="option"]', 'Campaign name').click();
        cy.get('#script-editor').should('contain.text', 'and {{campaign_id}}');
    });

    it('offers only fields shared by both channels', () => {
        cy.chooseChannels(['gmail', 'whatsapp']);
        cy.typeMessage('{{');
        cy.get('#mention-menu [role="option"]').should('have.length', 3)
            .and('not.contain', 'Email address').and('not.contain', 'Phone number');
        cy.get('#script-editor').type('{esc}');
        cy.get('#mention-menu').should('not.be.visible');
        cy.get('#compose').should('be.visible');
    });

    it('uploads a PDF from the dialog and selects it', () => {
        cy.get('#compose-upload').selectFile('tests/fixtures/sample-document.pdf', { force: true });
        cy.contains('#toast', 'Uploaded sample-document.pdf');
        cy.get('#campaign-attachment').should('have.value', 'sample-document.pdf');
        cy.get('#campaign-attachment option').should('have.length', 2);
    });

    it('attaches any common format but refuses programs', () => {
        cy.get('#compose-upload').selectFile({ contents: Cypress.Buffer.from('hello'), fileName: 'notes.txt' }, { force: true });
        cy.get('#campaign-attachment').should('have.value', 'notes.txt');
        cy.get('#compose-upload').selectFile({ contents: Cypress.Buffer.from('MZ'), fileName: 'setup.exe' }, { force: true });
        cy.get('#attachment-error').should('contain', 'This file type can’t be sent');
        cy.get('#campaign-attachment').should('have.value', 'notes.txt');
    });

    it('creates one campaign from a Gmail and WhatsApp workbook', () => {
        cy.get('#compose').find('[data-close]').first().click();
        cy.task('workbook:create', {
            name: 'both',
            channel: 'both',
            rows: [
                { 'Client Name': 'Ari', 'Email Address': 'ari@example.com', 'Phone Number': '+60123456789', Subject: 'Hi', ...optedIn },
                { 'Client Name': 'Ben', 'Email Address': 'ben@example.com', Subject: 'Hi', ...optedIn },
            ],
        }).then(path => {
            cy.openComposer();
            cy.get('#campaign-name').type('launch');
            cy.chooseChannels(['gmail', 'whatsapp']);
            cy.get('#channel-hint').should('be.visible');
            cy.get('#template-download').should('have.attr', 'href', '/api/template?channel=both');
            cy.get('input[name="workbook"]').selectFile(path, { force: true });
            cy.get('#compose-upload').selectFile('tests/fixtures/sample-document.pdf', { force: true });
            cy.get('#campaign-attachment').should('have.value', 'sample-document.pdf');
            cy.typeMessage('Hello {{client_name}}');
            cy.get('#compose-submit').click();
        });
        cy.location('pathname').should('eq', '/campaigns/launch');
        cy.get('#detail-heading').should('have.text', 'launch');
        cy.get('[data-detail-channel="gmail"]').click();
        cy.get('#detail-rows').should('contain', 'sample-document.pdf');
        cy.get('#close-detail').click();
        cy.get('#campaign-rows tr').should('have.length', 1).and('contain', 'launch');
        cy.get('#metric-queued').should('have.text', '3');
    });

    it('creates a campaign from typed-in recipients', () => {
        cy.get('#campaign-name').type('typed');
        cy.chooseChannels(['whatsapp']);
        cy.contains('.segmented label', 'Type in').click();
        cy.get('#source-excel').should('not.be.visible');
        cy.get('#recipient-head').should('have.text', 'NamePhone');
        cy.get('#compose-submit').click();
        cy.get('#recipients-error').should('have.text', 'Add at least one recipient.');

        cy.get('[aria-label="Name, row 1"]').type('Ari');
        cy.get('[aria-label="Phone, row 1"]').type('+60123456789{enter}');
        cy.get('[aria-label="Name, row 2"]').trigger('paste', {
            clipboardData: { getData: () => 'Ben\t0123456780\nCasey\t+60198765432' },
        });
        cy.get('.recipient-row').should('have.length', 3);
        cy.get('#recipient-count').should('have.text', '3 recipients');
        cy.get('[aria-label="Remove row 3"]').click();
        cy.get('#recipient-count').should('have.text', '2 recipients');

        cy.get('[aria-label="Phone, row 2"]').clear().type('((((((');
        cy.get('#compose-submit').click();
        cy.get('#recipients-error').should('have.text', 'Row 2: check the phone number.');
        cy.get('[aria-label="Phone, row 2"]').should('have.attr', 'aria-invalid', 'true').and('be.focused')
            .clear().type('0123456780');

        cy.typeMessage('Hi {{client_name}}');
        cy.get('#compose-submit').click();
        cy.get('#recipients-error').should('contain', 'agreed to receive');
        cy.get('#recipient-consent').check();
        cy.get('#compose-submit').click();
        cy.contains('#toast', 'Campaign created');
        cy.get('#detail-heading').should('have.text', 'typed');
        cy.get('#detail-rows').should('contain', 'Ari').and('contain', 'Ben').and('not.contain', 'Casey');
    });

    it('edits a saved draft with its channel locked', () => {
        cy.get('#compose').find('[data-close]').first().click();
        cy.importCampaign({
            name: 'editable',
            channels: ['gmail'],
            channel: 'gmail',
            rows: [{ 'Client Name': 'Ari', 'Email Address': 'ari@example.com', Subject: 'Hi', ...optedIn }],
            message: 'First',
        });
        cy.get('#detail-actions').contains('button', 'Edit').click();
        cy.get('#compose-title').should('have.text', 'Edit campaign');
        cy.get('#campaign-name').should('have.value', 'editable').and('have.attr', 'readonly');
        cy.get('input[value="whatsapp"]').should('be.disabled').and('not.be.checked');
        cy.get('#script-editor').should('have.text', 'First').type(' and second');
        cy.get('#compose-submit').click();
        cy.contains('#toast', 'Campaign updated');
        cy.get('#detail-rows').should('contain', 'First and second');
    });
});
