const EMAIL = 'dashboard@gmail.com';
const NAME = 'Dana Board';

describe('Audit log', () => {
    let days;

    beforeEach(() => {
        cy.task('audit:seed', { email: EMAIL, name: NAME }).then(seeded => { days = seeded; });
        cy.visit('/audit');
        cy.get('#audit-rows').should('not.have.attr', 'aria-busy');
    });

    const row = action => cy.contains('#audit-rows tr', action);
    const openPicker = () => cy.get('.date-range-trigger').click();
    const pickDay = day => cy.get(`.date-range-day[data-day="${day}"]`).click();
    const expectActions = ({ shown, hidden }) => {
        for (const action of shown) cy.get('#audit-rows').should('contain.text', action);
        for (const action of hidden) cy.get('#audit-rows').should('not.contain.text', action);
    };

    it('names each actor with their Google name, email and photo', () => {
        row('seed.today').within(() => {
            cy.get('.audit-actor-name').should('have.text', NAME);
            cy.get('.audit-actor-email').should('have.text', EMAIL);
            cy.get('.audit-avatar img').should('have.attr', 'src').and('match', /^data:image\/svg/u);
        });
        row('seed.old').within(() => {
            cy.get('.audit-actor-cell').should('have.text', 'Command line');
            cy.get('.audit-email-cell').should('have.text', '—');
        });
        cy.get('#user-name').should('have.text', NAME);
        cy.get('#user-avatar img').should('exist');
    });

    it('filters with a preset, keeps the range in the URL, and resets', () => {
        cy.get('#audit-reset').should('not.be.visible');
        cy.get('.date-range-trigger').should('contain.text', 'All dates');
        openPicker();
        cy.contains('.date-range-preset', 'Last 7 days').click();

        cy.get('.date-range-popover').should('not.be.visible');
        cy.location('search').should('include', 'from=').and('include', 'to=');
        cy.get('.date-range-trigger').should('have.class', 'active').and('not.contain.text', 'All dates');
        expectActions({ shown: ['seed.today', 'seed.recent'], hidden: ['seed.old'] });
        cy.get('#audit-count').should('contain.text', 'matching');

        cy.reload();
        expectActions({ shown: ['seed.recent'], hidden: ['seed.old'] });
        openPicker();
        cy.contains('.date-range-preset', 'Last 7 days').should('have.attr', 'aria-pressed', 'true');
        cy.focused().type('{esc}');
        cy.get('.date-range-popover').should('not.be.visible');

        cy.get('#audit-reset').should('be.visible').click();
        cy.location('search').should('eq', '');
        cy.get('.date-range-trigger').should('contain.text', 'All dates');
        cy.get('#audit-reset').should('not.be.visible');
        expectActions({ shown: ['seed.today', 'seed.recent', 'seed.old'], hidden: [] });
    });

    it('picks a custom range on the calendar in either order', () => {
        openPicker();
        cy.get('.date-range-popover').should('be.visible');
        cy.get('.date-range-popover button:contains("Apply")').should('be.disabled');

        pickDay(days.recent);
        cy.get('.date-range-summary').should('not.contain.text', 'Pick a start date');
        pickDay(days.old);
        cy.get(`.date-range-day[data-day="${days.old}"]`).should('have.class', 'range-start');
        cy.get(`.date-range-day[data-day="${days.recent}"]`).should('have.class', 'range-end');
        cy.get('.date-range-day.in-range').should('have.length.greaterThan', 0);
        cy.contains('.date-range-popover button', 'Apply').click();

        cy.location('search').should('include', `from=${days.old}`).and('include', `to=${days.recent}`);
        expectActions({ shown: ['seed.old', 'seed.recent'], hidden: ['seed.today'] });

        openPicker();
        pickDay(days.old);
        pickDay(days.old);
        cy.contains('.date-range-popover button', 'Apply').click();
        cy.location('search').should('eq', `?from=${days.old}`);
        expectActions({ shown: ['seed.old'], hidden: ['seed.today', 'seed.recent'] });

        cy.go('back');
        expectActions({ shown: ['seed.old', 'seed.recent'], hidden: ['seed.today'] });
    });

    it('cancels without changing the filter and blocks days outside retention', () => {
        openPicker();
        cy.get('.date-range-day.today').should('not.be.disabled');
        cy.get('.date-range-day:disabled').should('have.length.greaterThan', 0);
        pickDay(days.recent);
        cy.contains('.date-range-popover button', 'Cancel').click();
        cy.get('.date-range-popover').should('not.be.visible');
        cy.location('search').should('eq', '');
        cy.get('.date-range-trigger').should('contain.text', 'All dates');

        openPicker();
        cy.get('.date-range-day.range-start').should('not.exist');
        cy.get('h1').click();
        cy.get('.date-range-popover').should('not.be.visible');
    });

    it('explains an empty range and rejects a malformed one in the URL', () => {
        cy.visit('/audit?from=2000-01-01&to=2000-01-02');
        cy.get('#audit-empty').should('be.visible').and('contain.text', 'No events in this date range');
        cy.get('#audit-count').should('have.text', 'No events in this date range');
        cy.get('#audit-reset').click();
        cy.get('#audit-empty').should('not.be.visible');
        row('seed.today').should('exist');

        cy.visit('/audit?from=not-a-date');
        cy.get('.date-range-trigger').should('contain.text', 'All dates');
        row('seed.old').should('exist');
        cy.request({ url: '/api/audit?from=nope', failOnStatusCode: false }).its('status').should('eq', 400);
    });
});
