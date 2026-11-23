// The browser request is stubbed, so these specs never call Groq.
describe('AI writing', () => {
    beforeEach(() => {
        cy.openDashboard();
        cy.openComposer();
    });

    it('writes the fallback subject and message from a prompt', () => {
        cy.intercept('POST', '/api/drafts/generate', {
            statusCode: 200,
            body: {
                subject: 'Your December invite, {{client_name}}',
                html: '<p>Hi <b>{{client_name}}</b>,</p><ul><li>Live demo</li></ul>',
                text: 'Hi {{client_name}},\n\n * Live demo',
            },
        }).as('generate');

        cy.get('#ai-bar').should('be.visible');
        cy.get('#ai-generate').should('contain', 'Write');
        cy.get('#ai-prompt').type('Invite clients to the December webinar{enter}');
        cy.wait('@generate').its('request.body').should('deep.include', {
            prompt: 'Invite clients to the December webinar',
            channels: ['gmail'],
        });
        cy.get('#campaign-subject').should('have.value', 'Your December invite, {{client_name}}');
        cy.get('#script-editor b').should('have.text', '{{client_name}}');
        cy.get('#script-editor li').should('have.text', 'Live demo');
        cy.get('#ai-generate').should('contain', 'Rewrite');
        cy.contains('#toast', 'Draft written');
    });

    it('sends the current draft and both channels when rewriting', () => {
        cy.intercept('POST', '/api/drafts/generate', { body: { subject: '', html: '<p>Short</p>', text: 'Short' } }).as('generate');
        cy.chooseChannels(['gmail', 'whatsapp']);
        cy.typeMessage('A long first draft');
        cy.get('#ai-prompt').type('Make it shorter');
        cy.get('#ai-generate').click();
        cy.wait('@generate').its('request.body').should('deep.include', {
            channels: ['gmail', 'whatsapp'],
            message: 'A long first draft',
        });
        cy.get('#script-editor').should('have.text', 'Short');
    });

    it('asks for a prompt before calling the service', () => {
        cy.intercept('POST', '/api/drafts/generate', cy.spy().as('generate'));
        cy.get('#ai-generate').click();
        cy.get('#ai-error').should('contain', 'Describe the message you want');
        cy.get('@generate').should('not.have.been.called');
    });

    it('shows service errors without touching the draft', () => {
        cy.intercept('POST', '/api/drafts/generate', { statusCode: 502, body: { error: 'The AI service is busy. Try again in a minute.' } });
        cy.typeMessage('Keep me');
        cy.get('#ai-prompt').type('Rewrite this');
        cy.get('#ai-generate').click();
        cy.get('#ai-error').should('have.text', 'The AI service is busy. Try again in a minute.');
        cy.get('#script-editor').should('have.text', 'Keep me');
    });
});
