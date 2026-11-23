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
        cy.get('#mention-menu').should('be.visible').find('[role="option"]').should('have.length', 2)
            .first().should('have.attr', 'aria-selected', 'true').and('contain', 'Client name');
        cy.get('#script-editor').type('{downArrow}{enter}');
        cy.get('#mention-menu').should('not.be.visible');
        cy.get('#script-editor').should('contain.text', 'Hi {{client_id}}');

        cy.get('#script-editor').type(' and {{', { parseSpecialCharSequences: false });
        cy.get('#mention-menu [role="option"]').should('have.length', 5);
        cy.get('#mention-menu').contains('[role="option"]', 'Campaign name').click();
        cy.get('#script-editor').should('contain.text', 'and {{campaign_id}}');
    });

    it('offers only fields shared by both channels', () => {
        cy.chooseChannels(['gmail', 'whatsapp']);
        cy.typeMessage('{{');
        cy.get('#mention-menu [role="option"]').should('have.length', 4)
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

    it('sends one workbook to Gmail and WhatsApp at once', () => {
        cy.get('#compose').find('[data-close]').first().click();
        cy.task('workbook:create', {
            name: 'both',
            channel: 'both',
            rows: [
                { 'Client ID': 'C1', 'Client Name': 'Ari', 'Email Address': 'ari@example.com', 'Phone Number': '+60123456789', Subject: 'Hi', ...optedIn },
                { 'Client ID': 'C2', 'Client Name': 'Ben', 'Email Address': 'ben@example.com', Subject: 'Hi', ...optedIn },
            ],
        }).then(path => {
            cy.openComposer();
            cy.get('#campaign-name').type('launch');
            cy.chooseChannels(['gmail', 'whatsapp']);
            cy.get('#channel-hint').should('have.text', 'Creates launch-gmail and launch-whatsapp.');
            cy.get('#template-download').should('have.attr', 'href', '/api/template?channel=both');
            cy.get('input[name="workbook"]').selectFile(path, { force: true });
            cy.get('#compose-upload').selectFile('tests/fixtures/sample-document.pdf', { force: true });
            cy.get('#campaign-attachment').should('have.value', 'sample-document.pdf');
            cy.typeMessage('Hello {{client_name}}');
            cy.get('#compose-submit').click();
        });
        cy.contains('#toast', 'Created 2 campaigns');
        cy.get('#campaign-rows tr').should('have.length', 2);
        cy.get('#campaign-rows').should('contain', 'launch-gmail').and('contain', 'launch-whatsapp');
        cy.get('#metric-queued').should('have.text', '3');
        cy.get('#detail-heading').should('have.text', 'launch-gmail');
        cy.get('#detail-rows').should('contain', 'sample-document.pdf');
    });

    it('edits a saved draft with its channel locked', () => {
        cy.get('#compose').find('[data-close]').first().click();
        cy.importCampaign({
            name: 'editable',
            channels: ['gmail'],
            channel: 'gmail',
            rows: [{ 'Client ID': 'C1', 'Client Name': 'Ari', 'Email Address': 'ari@example.com', Subject: 'Hi', ...optedIn }],
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
