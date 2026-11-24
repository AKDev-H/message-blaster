const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function upload(file) {
    cy.get('#library-upload').selectFile(file, { force: true });
}

function view(name) {
    cy.contains('#library-files li', name).find('button').contains('View').click();
    cy.get('#viewer').should('be.visible');
    cy.get('#viewer-title').should('have.text', name);
}

describe('Attachments and document viewer', () => {
    beforeEach(() => {
        cy.openDashboard();
        cy.get('#open-library').click();
        cy.get('#library').should('be.visible');
    });

    it('accepts any common format and refuses programs', () => {
        upload({ contents: Cypress.Buffer.from('Quarterly notes'), fileName: 'notes.txt' });
        cy.contains('#toast', 'Uploaded notes.txt');
        upload({ contents: Cypress.Buffer.from('MZ'), fileName: 'setup.exe' });
        cy.get('#library-error').should('contain', 'This file type can’t be sent');
        cy.get('#library-files li').should('have.length', 1).first().should('contain', 'TXT').and('contain', 'notes.txt');
    });

    it('shows text and CSV files', () => {
        upload({ contents: Cypress.Buffer.from('Quarterly notes\nLine two'), fileName: 'notes.txt' });
        upload({ contents: Cypress.Buffer.from('Name,City\n"Ari, Jr.",Penang\nBen,Ipoh'), fileName: 'clients.csv' });
        view('notes.txt');
        cy.get('.viewer-text').should('contain', 'Quarterly notes').and('contain', 'Line two');
        cy.get('#viewer [data-close]').click();

        view('clients.csv');
        cy.get('.viewer-table th').should('have.length', 2).first().should('have.text', 'Name');
        cy.get('.viewer-table tr').eq(1).find('td').first().should('have.text', 'Ari, Jr.');
    });

    it('shows images and PDFs inline with a download link', () => {
        upload({ contents: Cypress.Buffer.from(png, 'base64'), fileName: 'logo.png' });
        upload('tests/fixtures/sample-document.pdf');
        view('logo.png');
        cy.get('.viewer-image').should('have.attr', 'src', '/api/attachments/logo.png')
            .and($image => expect($image[0].naturalWidth).to.equal(1));
        cy.get('#viewer-download').should('have.attr', 'href', '/api/attachments/logo.png?download');
        cy.get('#viewer [data-close]').click();

        view('sample-document.pdf');
        cy.get('.viewer-frame').should('have.attr', 'src', '/api/attachments/sample-document.pdf');
        cy.request('/api/attachments/sample-document.pdf').its('headers.content-type').should('eq', 'application/pdf');
    });

    it('renders Word documents and Excel workbooks', () => {
        cy.task('docx:create', { name: 'proposal', heading: 'Proposal for Ari', paragraph: 'Pricing is attached.' }).then(upload);
        cy.task('workbook:create', {
            name: 'prices',
            channel: 'gmail',
            rows: [{ 'Client Name': 'Ari', 'Email Address': 'ari@example.com' }],
        }).then(upload);

        view('proposal.docx');
        cy.get('.viewer-document h1').should('have.text', 'Proposal for Ari');
        cy.get('.viewer-document strong').should('have.text', 'Pricing is attached.');
        cy.get('#viewer [data-close]').click();

        view('prices.xlsx');
        cy.get('.viewer-table th').first().should('have.text', 'Client Name');
        cy.get('.viewer-table td').should('contain', 'ari@example.com');
    });

    it('offers a download when a format cannot be previewed', () => {
        upload({ contents: Cypress.Buffer.from('slides'), fileName: 'deck.pptx' });
        view('deck.pptx');
        cy.get('.viewer-empty').should('contain', 'No preview for .pptx files');
        cy.get('#viewer-download').should('have.attr', 'href', '/api/attachments/deck.pptx?download');
    });

    it('previews the attachment chosen in the campaign dialog and from recipient rows', () => {
        cy.get('#library [data-close]').click();
        cy.openComposer();
        cy.get('#attachment-preview').should('be.disabled');
        cy.get('#compose-upload').selectFile({ contents: Cypress.Buffer.from('Terms'), fileName: 'terms.txt' }, { force: true });
        cy.get('#campaign-attachment').should('have.value', 'terms.txt');
        cy.get('#attachment-preview').should('not.be.disabled').click();
        cy.get('#viewer-title').should('have.text', 'terms.txt');
        cy.get('.viewer-text').should('have.text', 'Terms');
        cy.get('#viewer [data-close]').click();
        cy.get('#compose [data-close]').first().click();

        cy.importCampaign({
            name: 'with-file',
            channels: ['gmail'],
            channel: 'gmail',
            rows: [{ 'Client Name': 'Ari', 'Email Address': 'ari@example.com', Subject: 'Hi', 'PDF Filename': 'terms.txt', 'Consent Status': 'Opted In' }],
        });
        cy.get('#detail-rows').contains('button', 'terms.txt').click();
        cy.get('#viewer-title').should('have.text', 'terms.txt');
    });
});
