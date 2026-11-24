const SIZES = { phone: [375, 812], 'tablet portrait': [768, 1024], 'tablet landscape': [1024, 768] };
const rows = [{ 'Client Name': 'Ari', 'Email Address': 'ari@example.com', 'Phone Number': '+60123456789', 'Consent Status': 'Opted In', Subject: 'Hi' }];

function expectNoSidewaysScroll() {
    cy.document().then(doc => expect(doc.documentElement.scrollWidth, 'page width').to.be.at.most(doc.documentElement.clientWidth));
}

function rect(element) {
    return element.getBoundingClientRect();
}

function overlaps(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe('Responsive layout', () => {
    for (const [label, [width, height]] of Object.entries(SIZES)) {
        it(`fits every page on a ${label} screen with the account menu in reach`, () => {
            cy.openDashboard();
            cy.importCampaign({ name: 'layout-check', channels: ['gmail', 'whatsapp'], channel: 'both', rows });
            cy.viewport(width, height);
            for (const path of ['/', '/campaigns/layout-check', '/audit']) {
                cy.visit(path);
                cy.get('#user-menu-trigger').should('be.visible').then(trigger => {
                    expect(rect(trigger[0]).right, 'account menu inside the screen').to.be.at.most(width);
                });
                expectNoSidewaysScroll();
            }
        });
    }

    it('keeps the phone tab bar on one row and the + button clear of every tab', () => {
        cy.viewport(...SIZES.phone);
        cy.visit('/');
        cy.get('#open-audit').should('be.visible');
        cy.get('.topnav .nav-item:visible').then(items => {
            const tops = new Set([...items].map(item => Math.round(rect(item).top)));
            expect(tops.size, 'tab rows').to.equal(1);
            cy.get('#create-campaign').then(fab => {
                for (const item of items) expect(overlaps(rect(fab[0]), rect(item)), `+ covers ${item.textContent.trim()}`).to.equal(false);
            });
        });
        cy.contains('.nav-item', 'Settings').click();
        cy.get('#settings').should('be.visible');
    });

    it('opens a campaign on a phone as a pushed screen with a back bar and action tiles', () => {
        cy.task('campaigns:seed', { count: 1 });
        cy.viewport(...SIZES.phone);
        cy.visit('/');
        cy.get('#campaign-rows [data-campaign]').first().click();
        cy.get('#close-detail').should('be.visible').and('contain.text', 'Campaigns').then(back => {
            expect(rect(back[0]).top, 'back bar pinned to the top').to.be.at.most(1);
            expect(rect(back[0]).width, 'back bar spans the screen').to.equal(SIZES.phone[0]);
        });
        cy.get('#detail-actions .button').should('have.length.greaterThan', 1).each(tile => {
            expect(rect(tile[0]).height, `${tile.text().trim()} is a touch-sized tile`).to.be.at.least(44);
        });
        cy.get('.details-panel').scrollTo('bottom', { ensureScrollable: false });
        cy.get('#close-detail').should('be.visible').click();
        cy.location('pathname').should('eq', '/');
    });

    it('shows the audit log as readable cards on a phone', () => {
        cy.viewport(...SIZES.phone);
        cy.task('audit:seed', { email: 'dashboard@gmail.com', name: 'Dana Board' });
        cy.visit('/audit');
        cy.contains('#audit-rows tr', 'seed.recent').within(() => {
            cy.get('.audit-actor-sub').should('be.visible').and('have.text', 'dashboard@gmail.com');
            cy.get('.audit-badge').should('be.visible');
        });
        cy.get('.back-to-dashboard').should('not.be.visible');
        cy.get('.date-range-trigger').click();
        cy.get('.date-range-popover').should('be.visible').then(sheet => {
            expect(rect(sheet[0]).bottom).to.be.at.most(SIZES.phone[1]);
        });
        cy.get('.date-range-day.today').should('be.visible');
    });
});
