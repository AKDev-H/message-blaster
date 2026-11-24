describe('Dashboard', () => {
    it('shows the top bar, preview mode and an empty queue', () => {
        cy.openDashboard();
        cy.get('.topbar').within(() => {
            cy.contains('.brand', 'Message Blaster');
            cy.contains('.nav-item', 'Campaigns').should('have.attr', 'aria-current', 'page');
            cy.contains('.nav-item', 'Attachments');
            cy.get('#mode-indicator').should('be.visible').and('contain', 'Preview mode');
        });
        cy.get('.sidebar').should('not.exist');
        cy.contains('Sending help').should('not.exist');
        cy.get('#campaign-empty').should('be.visible').and('contain', 'No campaigns yet');
        cy.get('#metric-queued').should('have.text', '0');
    });

    it('offers empty Excel templates with only the column titles', () => {
        cy.openDashboard();
        cy.get('#metric-rail').should('not.exist');
        cy.get('#template-menu summary').click();
        cy.get('#template-menu [role="menuitem"]').should('have.length', 3);
        const expected = {
            gmail: ['Client Name', 'Email Address', 'Subject', 'Message', 'Attachment', 'Consent Status', 'Campaign ID'],
            whatsapp: ['Client Name', 'Phone Number', 'Message', 'Attachment', 'Consent Status', 'Campaign ID'],
            both: ['Client Name', 'Email Address', 'Phone Number', 'Subject', 'Message', 'Attachment', 'Consent Status', 'Campaign ID'],
        };
        for (const [channel, headers] of Object.entries(expected)) {
            cy.get(`#template-menu a[href="/api/template?channel=${channel}"]`).should('have.attr', 'download');
            cy.request({ url: `/api/template?channel=${channel}`, encoding: 'base64' }).then(response => {
                cy.task('workbook:inspect', response.body).should('deep.equal', { headers, rows: 1 });
            });
        }
        cy.get('#template-menu').should('have.attr', 'open');
        cy.get('#queue-heading').click();
        cy.get('#template-menu').should('not.have.attr', 'open');
    });

    it('starts with an empty attachment library: files only come from uploads', () => {
        cy.openDashboard();
        cy.get('#open-library').click();
        cy.get('#library-files').should('have.text', 'No files uploaded yet.');
        cy.request('/api/attachments').its('body.files').should('have.length', 0);
    });

    it('renders Lucide icons in place of placeholders', () => {
        cy.openDashboard();
        cy.get('i[data-icon]').should('not.exist');
        cy.get('#create-campaign svg.icon-plus').should('exist');
        cy.get('#open-library svg.icon-paperclip').should('exist');
    });

    it('creates a campaign and shows live totals, details and the formatted preview', () => {
        cy.openDashboard();
        cy.importCampaign({
            name: 'november',
            channels: ['gmail'],
            channel: 'gmail',
            rows: [
                { 'Client Name': 'Ari', 'Email Address': 'ari@example.com', Subject: 'Hello', 'Consent Status': 'Opted In' },
                { 'Client Name': 'Ben', 'Email Address': 'ben@example.com', Subject: 'Hello', 'Consent Status': 'Opted In' },
            ],
        });
        cy.contains('#toast', 'Campaign created');
        cy.get('#metric-queued').should('have.text', '2');
        cy.get('#details').should('be.visible');
        cy.get('#detail-heading').should('have.text', 'november');
        cy.get('#detail-rows tr').should('have.length', 2).first().should('contain', 'Ari').and('contain', 'Hi Ari');
        cy.get('#detail-actions').contains('button', 'Start sending').should('be.disabled');
    });

    it('filters the queue and restores it', () => {
        cy.openDashboard();
        cy.importCampaign({
            name: 'only-mail',
            channels: ['gmail'],
            channel: 'gmail',
            rows: [{ 'Client Name': 'Ari', 'Email Address': 'ari@example.com', Subject: 'Hi', 'Consent Status': 'Opted In' }],
        });
        cy.get('#channel-filter').select('WhatsApp');
        cy.get('#campaign-empty').should('contain', 'No matching campaigns');
        cy.get('#empty-action').click();
        cy.get('#campaign-rows tr').should('have.length', 1);
    });

    it('deletes a campaign after confirmation', () => {
        cy.openDashboard();
        cy.importCampaign({
            name: 'to-delete',
            channels: ['gmail'],
            channel: 'gmail',
            rows: [{ 'Client Name': 'Ari', 'Email Address': 'ari@example.com', Subject: 'Hi', 'Consent Status': 'Opted In' }],
        });
        cy.get('#detail-actions').contains('button', 'Delete').click();
        cy.get('#confirm').should('be.visible').and('contain', 'permanently deletes');
        cy.get('#confirm-submit').click();
        cy.contains('#toast', 'Campaign deleted');
        cy.get('#campaign-empty').should('be.visible');
        cy.get('#details').should('not.be.visible');
    });
});
