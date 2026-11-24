beforeEach(() => {
    cy.task('db:reset');
});

Cypress.Commands.add('openDashboard', () => {
    cy.visit('/');
    cy.get('#connection').should('have.attr', 'data-mode', 'live');
});

Cypress.Commands.add('openComposer', () => {
    cy.get('#create-campaign').click();
    cy.get('#compose').should('be.visible');
});

Cypress.Commands.add('typeMessage', { prevSubject: false }, text => {
    cy.get('#script-editor').click().type(text, { parseSpecialCharSequences: false });
});

Cypress.Commands.add('chooseChannels', channels => {
    for (const channel of ['gmail', 'whatsapp']) {
        cy.get(`input[name="channel"][value="${channel}"]`)[channels.includes(channel) ? 'check' : 'uncheck']({ force: true });
    }
});

Cypress.Commands.add('importCampaign', ({ name, channels, channel, rows, message = 'Hi {{client_name}}' }) => {
    cy.task('workbook:create', { name, channel, rows }).then(path => {
        cy.openComposer();
        cy.get('#campaign-name').type(name);
        cy.chooseChannels(channels);
        cy.get('input[name="workbook"]').selectFile(path, { force: true });
        cy.typeMessage(message);
        cy.get('#compose-submit').click();
        cy.get('#compose').should('not.be.visible');
    });
});
