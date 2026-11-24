const optedIn = { 'Consent Status': 'Opted In', Subject: 'Your renewal' };
const rows = [
    { 'Client Name': 'Ari', 'Email Address': 'ari@example.com', 'Phone Number': '+60123456789', ...optedIn },
    { 'Client Name': 'Ben', 'Email Address': 'ben@example.com', ...optedIn },
    { 'Client Name': 'Cy', 'Phone Number': '+60123456788', ...optedIn },
];

function importCombined(name) {
    cy.importCampaign({ name, channels: ['gmail', 'whatsapp'], channel: 'both', rows });
    cy.location('pathname').should('eq', '/campaigns/' + name);
}

function metric(key, value) {
    cy.get(`[data-detail-metric="${key}"] strong`).should('have.text', String(value));
}

describe('Campaign detail pages', () => {
    it('opens a stable link from a filtered list and restores the list on Back', () => {
        cy.task('campaigns:seed', { count: 34 });
        cy.openDashboard();
        cy.contains('.channel-toggle', 'WhatsApp').click();
        cy.get('#campaign-next').click();
        cy.get('#campaign-pages [aria-current="page"]').should('have.text', '2');
        cy.get('#campaign-rows [data-campaign]').first().then(link => {
            const href = link.attr('href');
            expect(href).to.match(/^\/campaigns\/promo-/);
            cy.wrap(link).click();
            cy.location('pathname').should('eq', href);
            cy.get('#detail-heading').should('contain', 'promo-');
            cy.reload();
            cy.get('#detail-rows').should('contain', 'Ari');
            cy.go('back');
            cy.get('#campaign-pages [aria-current="page"]').should('have.text', '2');
            cy.contains('.channel-toggle', 'WhatsApp').should('have.attr', 'aria-pressed', 'true');
        });
        cy.request({ url: '/campaigns/does-not-exist', failOnStatusCode: false }).its('status').should('eq', 404);
    });

    it('lists one campaign for both channels and counts people separately from successful sends', () => {
        cy.openDashboard();
        importCombined('touchpoints');
        cy.get('[data-detail-channel="gmail"]').should('be.visible');
        cy.get('[data-detail-channel="whatsapp"]').should('be.visible');
        metric('peopleSent', 0);
        metric('completed', 0);
        metric('failed', 0);
        cy.request('/api/campaign-groups/touchpoints').its('body.channels').then(channels => {
            cy.task('campaign:simulate', {
                id: channels.find(channel => channel.channel === 'gmail').id,
                state: 'Completed',
                statuses: { SENT: 1, FAILED: 1 },
            });
            cy.task('campaign:simulate', {
                id: channels.find(channel => channel.channel === 'whatsapp').id,
                state: 'Completed',
                statuses: { DELIVERED: 1, READ: 1 },
            });
        });
        metric('peopleSent', 2);
        metric('completed', 3);
        metric('failed', 1);
        metric('read', 1);

        cy.get('[data-detail-channel="gmail"]').click();
        cy.get('#detail-rows').should('contain', 'Ari').and('contain', 'Ben').and('not.contain', 'Cy');
        cy.get('#detail-rows .message-body summary').first().click();
        cy.get('#detail-rows .message-body').first().should('have.attr', 'open');
        cy.get('[data-detail-channel="whatsapp"]').click();
        cy.get('#detail-rows').should('contain', 'Ari').and('contain', 'Cy').and('not.contain', 'Ben');

        cy.get('#close-detail').click();
        cy.get('#campaign-rows tr').should('have.length', 1).and('contain', 'touchpoints');
        cy.contains('.channel-toggle', 'Gmail').click();
        cy.get('#campaign-rows tr').should('have.length', 1).and('contain', 'touchpoints');
        cy.contains('.channel-toggle', 'WhatsApp').click();
        cy.get('#campaign-rows tr').should('have.length', 1).and('contain', 'touchpoints');
    });

    it('keeps private campaign links and their exports behind sign-in', () => {
        cy.openDashboard();
        importCombined('private-campaign');
        cy.get('#sign-out').click();
        cy.location('pathname').should('eq', '/login');
        cy.request({ url: '/campaigns/private-campaign', followRedirect: false }).its('redirectedToUrl').should('include', '/login');
        for (const path of ['/api/campaign-groups/private-campaign', '/api/campaign-groups/private-campaign/gmail/export', '/api/events']) {
            cy.request({ url: path, failOnStatusCode: false }).its('status').should('eq', 401);
        }
    });
});
