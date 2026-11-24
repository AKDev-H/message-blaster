describe('Campaign list', () => {
    function seedCampaigns(count) {
        cy.task('campaigns:seed', { count });
    }

    it('filters on the server and pages through campaigns ten at a time', () => {
        seedCampaigns(23);
        const listed = query => cy.intercept({ method: 'GET', pathname: '/api/campaigns', query });
        listed({ page: '2' }).as('page2');
        listed({ page: '1', channel: 'whatsapp' }).as('whatsapp');
        listed({ page: '1', channel: 'whatsapp', status: 'processing' }).as('sending');
        cy.openDashboard();
        cy.get('#campaign-count').should('have.text', '23 campaigns');
        cy.get('#campaign-rows tr').should('have.length', 10);
        cy.get('#campaign-range').should('have.text', 'Showing 1–10 of 23');
        cy.get('#campaign-pages [aria-current="page"]').should('have.text', '1');

        cy.get('#campaign-next').click();
        cy.wait('@page2');
        cy.get('#campaign-range').should('have.text', 'Showing 11–20 of 23');
        cy.contains('#campaign-pages button', '3').click();
        cy.get('#campaign-rows tr').should('have.length', 3);
        cy.get('#campaign-next').should('be.disabled');

        cy.get('.filter-group').should('contain', 'Filter By');
        cy.contains('.channel-toggle', 'WhatsApp').click();
        cy.wait('@whatsapp');
        cy.get('#campaign-count').should('have.text', '8 of 23 campaigns');
        cy.get('#campaign-pagination').should('not.be.visible');
        cy.get('#campaign-rows tr').each(row => cy.wrap(row).should('contain', 'WhatsApp'));

        cy.contains('.status-tab', 'Sending').click();
        cy.wait('@sending');
        cy.get('#campaign-empty').should('be.visible').and('contain', 'No matching campaigns');
        cy.get('#empty-icon svg.icon-search-x').should('exist');
        cy.get('#empty-action').should('contain', 'Clear filters').click();
        cy.get('#campaign-count').should('have.text', '23 campaigns');
    });

    it('shows a skeleton instead of a blank list while a page loads', () => {
        seedCampaigns(12);
        cy.intercept('GET', '/api/campaigns*', req => req.continue(res => res.setDelay(600))).as('slowList');
        cy.visit('/');
        cy.get('#campaign-rows .skeleton-row').should('have.length.greaterThan', 0);
        cy.get('#campaign-rows').should('have.attr', 'aria-busy', 'true');
        cy.wait('@slowList');
        cy.get('#campaign-rows .skeleton-row').should('not.exist');
        cy.get('#campaign-rows tr').should('have.length', 10);
        cy.get('#campaign-next').click();
        cy.get('#campaign-rows .skeleton-row').should('exist');
        cy.get('#campaign-rows tr').should('have.length', 2);
    });

    it('shows an icon and an icon button on the empty dashboard', () => {
        cy.openDashboard();
        cy.get('#campaign-empty').should('be.visible');
        cy.get('#empty-icon svg.icon-megaphone').should('exist');
        cy.get('#empty-action svg.icon-plus').should('exist');
        cy.get('#empty-action').should('contain', 'New campaign').click();
        cy.get('#compose').should('be.visible');
    });
});

describe('Status pages', () => {
    it('shows the 404 page with the app logo, an animation and a way back home', () => {
        cy.visit('/no/such/page', { failOnStatusCode: false });
        cy.title().should('eq', 'Page not found | Message Blaster');
        cy.get('.brand .brand-mark svg.icon-megaphone').should('exist');
        cy.get('#requested-path').should('have.text', '/no/such/page');
        cy.get('.status-art.ready svg').should('exist');
        cy.contains('a', 'Way Back Home').should('have.attr', 'href', '/').click();
        cy.location('pathname').should('eq', '/');
        cy.get('#page-title').should('have.text', 'Campaigns');
    });

    it('shows the 500 page with a Retry button', () => {
        cy.request({ url: '/errors/500', failOnStatusCode: false, headers: { Accept: 'text/html' } }).its('status').should('eq', 500);
        cy.visit('/errors/500', { failOnStatusCode: false });
        cy.get('.status-art.ready svg').should('exist');
        cy.contains('h1', 'The dashboard lost its signal');
        cy.contains('button', 'Retry').click();
        cy.location('pathname').should('eq', '/');
    });

    it('shows the maintenance page with the brand mark on the gears', () => {
        cy.request({ url: '/errors/maintenance', failOnStatusCode: false, headers: { Accept: 'text/html' } }).its('status').should('eq', 503);
        cy.visit('/errors/maintenance', { failOnStatusCode: false });
        cy.contains('h1', 'Message Blaster is being updated');
        cy.get('.art-logo svg.icon-megaphone').should('exist');
        cy.get('.status-art.ready svg').should('exist');
    });
});
