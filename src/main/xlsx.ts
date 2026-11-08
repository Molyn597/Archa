import { strToU8, zipSync } from 'fflate';
import type { Cell } from '../shared/invoices';

const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Sloupec A, B, … Z, AA… */
const column = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Pořadové číslo dne v Excelu (1900) pro RRRR-MM-DD. */
export function excelDate(iso: string): number | undefined {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000) + 25569 : undefined;
}

// Styly: 0 běžný, 1 tučná hlavička, 2 datum d.m.yyyy, 3 číslo s dvěma desetinnými místy.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="d\\.m\\.yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

/** Jednolistový .xlsx (minimální SpreadsheetML): čísla jako čísla, data jako data, tučná hlavička, filtr a ukotvená hlavička. */
export function buildXlsx(sheetName: string, headers: string[], rows: Cell[][]): Uint8Array {
  const str = (ref: string, s: string, style = 0) => `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
  const widths = headers.map((h) => h.length);
  const body = rows.map((row, r) => {
    const cells = row.map((c, i) => {
      const ref = `${column(i)}${r + 2}`;
      if (c === null) return '';
      if (typeof c === 'number') {
        widths[i] = Math.max(widths[i], 12);
        return `<c r="${ref}" s="3"><v>${c}</v></c>`;
      }
      if (typeof c === 'object') {
        const serial = excelDate(c.date);
        widths[i] = Math.max(widths[i], 11);
        return serial === undefined ? str(ref, c.date) : `<c r="${ref}" s="2"><v>${serial}</v></c>`;
      }
      widths[i] = Math.max(widths[i], Math.min(c.length, 50));
      return str(ref, c);
    });
    return `<row r="${r + 2}">${cells.join('')}</row>`;
  });
  const head = `<row r="1">${headers.map((h, i) => str(`${column(i)}1`, h, 1)).join('')}</row>`;
  const last = `${column(Math.max(headers.length - 1, 0))}${rows.length + 1}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w + 3}" customWidth="1"/>`).join('')}</cols><sheetData>${head}${body.join('')}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  const name = esc(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
