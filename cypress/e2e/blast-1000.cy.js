const CUSTOMERS = 1_000;

function customerRows() {
    return Array.from({ length: CUSTOMERS }, (_, index) => {
        const number = index % 100 === 99 ? index - 1 : index;
        return {
            'Client Name': `Customer ${index + 1}`,
            'Phone Number': `+601${String(20_000_000 + number).padStart(8, '0')}`,
            'Consent Status': index % 50 === 3 ? 'Not Opted In' : 'Opted In',
        };
    });
}

const SKIPPED = 20 + 20;
const ELIGIBLE = CUSTOMERS - SKIPPED;

describe('1,000-customer WhatsApp blast', () => {
    beforeEach(() => {
        cy.openDashboard();
        cy.importCampaign({ name: 'blast-1000', channels: ['whatsapp'], channel: 'whatsapp', rows: customerRows() });
        cy.contains('#toast', 'Campaign created');
    });

    it('imports 1,000 rows, skips duplicates and missing consent, and pages through recipients', () => {
        cy.location('pathname').should('eq', '/campaigns/blast-1000');
        cy.get('#detail-summary .detail-count.queued strong').should('have.text', ELIGIBLE.toLocaleString());
        cy.get('#detail-summary .detail-count.skipped strong').should('have.text', String(SKIPPED));

        cy.get('#detail-rows tr').should('have.length', 25).first().should('contain', 'Customer 1').and('contain', 'Hi Customer 1');
        cy.get('#page-number').should('have.text', '1 / 40');
        cy.get('#previous-page').should('be.disabled');
        cy.get('#next-page').click();
        cy.get('#page-number').should('have.text', '2 / 40');
        cy.get('#detail-rows tr').first().should('contain', 'Customer 26');
    });

    it('shows live progress as messages go out, then the finished totals', () => {
        cy.task('campaign:simulate', { id: 'blast-1000', state: 'Running', statuses: { DELIVERED: 300, READ: 150, SENDING: 1 } });
        cy.get('#detail-summary .detail-count.processing strong').should('have.text', '1');
        cy.get('#detail-summary .detail-count.completed strong').should('have.text', '450');
        cy.get('#detail-summary .detail-count.queued strong').should('have.text', (ELIGIBLE - 451).toLocaleString());

        cy.task('campaign:simulate', { id: 'blast-1000', state: 'Completed', statuses: { DELIVERED: ELIGIBLE - 450 - 2, UNKNOWN: 2 } });
        cy.get('#detail-summary .detail-count.unknown strong').should('have.text', '2');
        cy.get('#close-detail').click();
        cy.get('#metric-queued').should('have.text', '0');
        cy.get('#metric-processing').should('have.text', '0');
        cy.get('#metric-completed').should('have.text', (ELIGIBLE - 2).toLocaleString());
        cy.get('#metric-failed-caption').should('be.visible').and('have.text', '2 to review');
        cy.get('#campaign-rows tr').should('contain', `${CUSTOMERS.toLocaleString()} / ${CUSTOMERS.toLocaleString()}`);
    });
});
