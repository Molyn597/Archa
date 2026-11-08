import { describe, expect, it } from 'vitest';
import { parseIsdoc } from '../src/main/isdoc';

const BODY = (p: string) => `
  <${p}DocumentType>1</${p}DocumentType>
  <${p}ID>FV-2024-0042</${p}ID>
  <${p}UUID>3f1c</${p}UUID>
  <${p}IssueDate>2024-03-05</${p}IssueDate>
  <${p}LocalCurrencyCode>CZK</${p}LocalCurrencyCode>
  <${p}Note>Poznámka &amp; dodatek</${p}Note>
  <${p}AccountingSupplierParty>
    <${p}Party>
      <${p}PartyIdentification><${p}ID>12345678</${p}ID></${p}PartyIdentification>
      <${p}PartyName><${p}Name>Dodavatel s.r.o.</${p}Name></${p}PartyName>
      <${p}PartyTaxScheme><${p}CompanyID>CZ12345678</${p}CompanyID><${p}TaxScheme>VAT</${p}TaxScheme></${p}PartyTaxScheme>
    </${p}Party>
  </${p}AccountingSupplierParty>
  <${p}AccountingCustomerParty>
    <${p}Party>
      <${p}PartyIdentification><${p}ID>87654321</${p}ID></${p}PartyIdentification>
      <${p}PartyName><${p}Name>Odběratel a.s.</${p}Name></${p}PartyName>
      <${p}PartyTaxScheme><${p}CompanyID>CZ87654321</${p}CompanyID></${p}PartyTaxScheme>
    </${p}Party>
  </${p}AccountingCustomerParty>
  <${p}InvoiceLines>
    <${p}InvoiceLine>
      <${p}ID>1</${p}ID>
      <${p}Item><${p}Description>Hosting serveru</${p}Description></${p}Item>
      <${p}TaxTotal><${p}TaxAmount>999.00</${p}TaxAmount></${p}TaxTotal>
    </${p}InvoiceLine>
  </${p}InvoiceLines>
  <${p}TaxTotal>
    <${p}TaxSubTotal><${p}TaxableAmount>10000.00</${p}TaxableAmount><${p}TaxAmount>2100.00</${p}TaxAmount></${p}TaxSubTotal>
    <${p}TaxAmount>2100.00</${p}TaxAmount>
  </${p}TaxTotal>
  <${p}LegalMonetaryTotal>
    <${p}TaxExclusiveAmount>10000.00</${p}TaxExclusiveAmount>
    <${p}TaxInclusiveAmount>12100.00</${p}TaxInclusiveAmount>
    <${p}PayableAmount>12100.00</${p}PayableAmount>
  </${p}LegalMonetaryTotal>
  <${p}PaymentMeans>
    <${p}Payment>
      <${p}Details>
        <${p}PaymentDueDate>2024-03-19</${p}PaymentDueDate>
        <${p}VariableSymbol>2024042</${p}VariableSymbol>
      </${p}Details>
    </${p}Payment>
  </${p}PaymentMeans>`;

const plain = `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">${BODY('')}\n</Invoice>`;
const prefixed = `<isdoc:Invoice xmlns:isdoc="http://isdoc.cz/namespace/2013" version="6.0.2">${BODY('isdoc:')}\n</isdoc:Invoice>`;

const EXPECTED = {
  subject: 'Hosting serveru',
  number: 'FV-2024-0042',
  vs: '2024042',
  supplier: 'Dodavatel s.r.o.',
  supplierId: '12345678',
  supplierVat: 'CZ12345678',
  customer: 'Odběratel a.s.',
  customerId: '87654321',
  customerVat: 'CZ87654321',
  net: '10 000,00 CZK',
  vat: '2 100,00 CZK',
  amount: '12 100,00 CZK',
  issued: '2024-03-05',
  due: '2024-03-19',
};

describe('parseIsdoc', () => {
  it('výchozí jmenný prostor', () => {
    expect(parseIsdoc(plain)).toEqual(EXPECTED);
  });

  it('prefix isdoc:', () => {
    expect(parseIsdoc(prefixed)).toEqual(EXPECTED);
  });

  it('bez položek subject z poznámky; PayableAmount chybí → TaxInclusiveAmount', () => {
    const xml = plain.replace(/<InvoiceLines>[\s\S]*<\/InvoiceLines>/, '').replace(/<PayableAmount>.*<\/PayableAmount>/, '');
    const facts = parseIsdoc(xml)!;
    expect(facts.subject).toBe('Poznámka & dodatek');
    expect(facts.amount).toBe('12 100,00 CZK');
  });

  it('nesmysl vrátí undefined', () => {
    expect(parseIsdoc('<html><body>ahoj</body></html>')).toBeUndefined();
    expect(parseIsdoc('')).toBeUndefined();
  });
});
