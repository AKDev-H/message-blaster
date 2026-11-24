describe('Dashboard access', () => {
    it('signs out, signs back in with Google, and opens the administrator audit log', () => {
        cy.openDashboard();
        cy.get('#sign-out').click();
        cy.location('pathname').should('eq', '/login');
        cy.request({ url: '/api/campaigns', failOnStatusCode: false }).its('status').should('eq', 401);
        cy.get('#google-sign-in').click();
        cy.location('pathname').should('eq', '/');
        cy.get('#open-audit').click();
        cy.location('pathname').should('eq', '/audit');
        cy.get('#audit-rows').should('contain.text', 'auth.sign_in').and('contain.text', 'auth.sign_out');
    });
});
