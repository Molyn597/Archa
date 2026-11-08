import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildXlsx, excelDate } from '../src/main/xlsx';

describe('buildXlsx', () => {
  const zip = unzipSync(buildXlsx('Faktury', ['Název', 'Částka', 'Datum'], [['A & <B>', 1234.5, { date: '2026-11-02' }], [null, 2, null]]));

  it('je zip s očekávanými částmi', () => {
    expect(Object.keys(zip).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    expect(strFromU8(zip['xl/workbook.xml'])).toContain('name="Faktury"');
  });

  it('čísla jsou čísla, data data a text je escapovaný', () => {
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<c r="B2" s="3"><v>1234.5</v></c>');
    expect(sheet).toContain(`<c r="C2" s="2"><v>${excelDate('2026-11-02')}</v></c>`);
    expect(sheet).toContain('A &amp; &lt;B&gt;');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(sheet).not.toContain('r="A3"');
  });

  it('datum jako pořadové číslo Excelu', () => {
    expect(excelDate('1970-01-01')).toBe(25569);
    expect(excelDate('2026-11-02')).toBe(46328);
  });
});
