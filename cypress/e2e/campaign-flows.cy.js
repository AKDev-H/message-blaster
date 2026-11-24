const contact = (name, email, phone) => ({
    'Client Name': name, 'Email Address': email, 'Phone Number': phone, Subject: 'Your renewal', 'Consent Status': 'Opted In',
});
const people = [contact('Ari', 'ari@example.com', '+60123456789'), contact('Ben', 'ben@example.com', ''), contact('Cy', '', '+60123456788')];

function channelId(slug, channel) {
    return cy.request(`/api/campaign-groups/${slug}`).its('body.channels').then(channels => channels.find(item => item.channel === channel).id);
}

function clearEditor() {
    cy.get('#script-editor').click().type('{selectall}{backspace}');
}

describe('Campaign pages and per-channel content', () => {
    it('customizes one channel, previews both, then resets the override to the shared message', () => {
        cy.openDashboard();
        cy.task('workbook:create', { name: 'overrides', channel: 'both', rows: people }).then(path => {
            cy.openComposer();
            cy.get('#campaign-name').type('overrides');
            cy.chooseChannels(['gmail', 'whatsapp']);
            cy.get('#content-tabs').should('be.visible');
            cy.get('input[name="workbook"]').selectFile(path, { force: true });
            cy.typeMessage('Hello {{client_name}}');

            cy.get('[data-content-tab="gmail"]').click();
            cy.get('#content-inherits').should('contain', 'Inherits shared message, subject, attachment');
            cy.get('#script-editor').should('contain', 'Hello {{client_name}}');
            cy.typeMessage(' {{phone_number}}');
            cy.get('#compose-submit').click();
            cy.get('#script-error').should('contain', 'isn’t available for Gmail');
            clearEditor();
            cy.typeMessage('Dear {{client_name}}');

            cy.get('[data-content-tab="whatsapp"]').click();
            clearEditor();
            cy.typeMessage('Hi {{client_name}} at {{phone_number}}');
            cy.get('[data-content-tab="shared"]').click();
            cy.get('#script-editor').should('contain', 'Hello {{client_name}}');
            cy.get('[data-content-tab="whatsapp"] .override-dot').should('be.visible');
            cy.get('[data-content-tab="whatsapp"]').click();
            cy.get('#content-inherits').should('contain', 'Customized: message');
            cy.get('#compose-submit').click();
        });
        cy.location('pathname').should('eq', '/campaigns/overrides');
        cy.get('[data-detail-channel="gmail"]').click();
        cy.get('#detail-rows').should('contain', 'Dear Ari').and('contain', 'Your renewal');
        cy.get('[data-detail-channel="whatsapp"]').click();
        cy.get('#detail-rows').should('contain', 'Hi Ari at +60123456789').and('contain', 'Hi Cy at +60123456788');

        cy.reload();
        cy.get('#detail-actions').contains('button', 'Edit').click();
        cy.get('[data-content-tab="whatsapp"]').click();
        cy.get('#script-editor').should('contain', 'Hi {{client_name}} at {{phone_number}}');
        cy.get('#content-reset').click();
        cy.get('#script-editor').should('contain', 'Hello {{client_name}}');
        cy.get('#content-reset').should('not.be.visible');
        cy.get('#compose-submit').click();
        cy.contains('#toast', 'Campaign updated');
        cy.get('[data-detail-channel="whatsapp"]').click();
        cy.get('#detail-rows').should('contain', 'Hello Ari').and('not.contain', 'Hi Ari at');
        cy.get('[data-detail-channel="gmail"]').click();
        cy.get('#detail-rows').should('contain', 'Dear Ari');
    });

    it('keeps the link through a rename, refuses a taken name and shows the 404 page for missing campaigns', () => {
        cy.openDashboard();
        cy.importCampaign({ name: 'spring', channels: ['gmail', 'whatsapp'], channel: 'both', rows: people });
        cy.get('#detail-actions').contains('button', 'Rename').click();
        cy.get('#rename-name').clear().type('Spring renewals 2026');
        cy.get('#confirm-submit').click();
        cy.get('#detail-heading').should('have.text', 'Spring renewals 2026');
        cy.location('pathname').should('eq', '/campaigns/spring');
        cy.title().should('eq', 'Spring renewals 2026 | Message Blaster');
        cy.get('#close-detail').click();
        cy.get('#campaign-rows').should('contain', 'Spring renewals 2026');
        cy.get('#campaign-rows [data-campaign="spring"]').should('have.attr', 'href', '/campaigns/spring');

        cy.task('workbook:create', { name: 'spring-again', channel: 'gmail', rows: [contact('Di', 'di@example.com', '')] }).then(path => {
            cy.openComposer();
            cy.get('#campaign-name').type('spring');
            cy.get('input[name="workbook"]').selectFile(path, { force: true });
            cy.typeMessage('Hello');
            cy.get('#compose-submit').click();
            cy.get('#id-error').should('contain', 'already uses this name');
            cy.get('#compose').find('[data-close]').first().click();
        });

        for (const path of ['/campaigns/no-such-campaign', '/campaigns/bad%20name!']) {
            cy.visit(path, { failOnStatusCode: false });
            cy.contains('a', /home|campaigns/iu).should('exist');
            cy.request({ url: path, failOnStatusCode: false }).its('status').should('eq', 404);
        }

        cy.visit('/campaigns/spring');
        cy.get('#detail-actions').contains('button', 'Delete').click();
        cy.get('#confirm-submit').click();
        cy.location('pathname').should('eq', '/');
        cy.get('#campaign-rows').should('not.contain', 'Spring renewals 2026');
        cy.request({ url: '/campaigns/spring', failOnStatusCode: false }).its('status').should('eq', 404);
    });

    it('pages recipients during live progress, keeps a message open, reviews an uncertain send and exports one channel', () => {
        const rows = Array.from({ length: 30 }, (_, index) => contact(`Client ${index + 1}`, '', `+6012345${String(6000 + index)}`));
        cy.openDashboard();
        cy.task('workbook:create', { name: 'paging', channel: 'whatsapp', rows }).then(path => {
            cy.openComposer();
            cy.get('#campaign-name').type('paging');
            cy.chooseChannels(['whatsapp']);
            cy.get('input[name="workbook"]').selectFile(path, { force: true });
            cy.get('#compose-upload').selectFile('tests/fixtures/sample-document.pdf', { force: true });
            cy.get('#campaign-attachment').should('have.value', 'sample-document.pdf');
            cy.typeMessage('Hello {{client_name}}');
            cy.get('#compose-submit').click();
        });
        cy.location('pathname').should('eq', '/campaigns/paging');
        cy.get('#detail-tabs').should('not.be.visible');
        cy.get('#detail-rows tr').should('have.length', 25);
        cy.get('#page-number').should('have.text', '1 / 2');
        cy.get('#detail-rows .message-body summary').first().click();
        cy.get('#detail-rows .message-body').first().should('have.attr', 'open');

        cy.task('campaign:simulate', { id: 'paging', state: 'Running', statuses: { SENT: 3, UNKNOWN: 1, SENDING: 1 } });
        cy.get('[data-detail-metric="completed"] strong').should('have.text', '3');
        cy.get('[data-detail-metric="unknown"] strong').should('have.text', '1');
        cy.get('#detail-rows .message-body').first().should('have.attr', 'open');

        cy.task('campaign:simulate', { id: 'paging', state: 'Paused', statuses: {} });
        cy.contains('#detail-rows tr', 'Client 4').within(() => cy.contains('button', 'Review').click());
        cy.get('#review-outcome').select('SENT');
        cy.get('#review-note').type('Client confirmed by phone');
        cy.get('#confirm-submit').click();
        cy.contains('#toast', 'Outcome recorded');
        cy.get('[data-detail-metric="completed"] strong').should('have.text', '4');

        cy.get('#next-page').click();
        cy.get('#page-number').should('have.text', '2 / 2');
        cy.get('#detail-rows tr').should('have.length', 5);
        cy.get('#detail-rows .file-pill').first().click();
        cy.get('#viewer').should('be.visible');
        cy.get('#viewer').find('[data-close]').click();

        cy.get('#detail-actions').contains('a', 'Export').should('have.attr', 'href', '/api/campaign-groups/paging/whatsapp/export')
            .then(link => cy.request({ url: link.attr('href'), encoding: 'base64' }))
            .then(response => {
                expect(response.headers['content-disposition']).to.contain('paging-whatsapp-results.xlsx');
                return cy.task('workbook:inspect', response.body);
            })
            .its('rows').should('eq', 31);
    });

    it('lists a combined campaign once and keeps each channel’s actions separate', () => {
        cy.openDashboard();
        cy.importCampaign({ name: 'pair', channels: ['gmail', 'whatsapp'], channel: 'both', rows: people });
        cy.get('#detail-actions').contains('button', 'Send both').should('be.disabled').and('have.attr', 'title', 'Sending is turned off in preview mode');
        channelId('pair', 'gmail').then(id => cy.task('campaign:simulate', { id, state: 'Completed', statuses: { SENT: 1, FAILED: 1 } }));
        cy.get('[data-channel-card="gmail"]').should('contain', '1 of 2 recipients sent').and('contain', '1 failed');
        cy.get('#detail-actions').contains('button', 'Send both').should('not.exist');
        cy.get('[data-detail-channel="gmail"]').click();
        cy.get('#channel-actions').should('contain', 'Retry failed').and('not.contain', 'Start sending');
        cy.get('[data-detail-channel="whatsapp"]').click();
        cy.get('#channel-actions').contains('button', 'Start sending WhatsApp').should('be.disabled');
        cy.get('#channel-actions').should('not.contain', 'Retry failed');
        cy.get('#close-detail').click();
        cy.location('pathname').should('eq', '/');
        cy.get('#campaign-rows tr').should('have.length', 1).and('contain', 'Gmail + WhatsApp');
    });
});
