import type { DocFacts } from '../shared/types';
import { parseIsdoc } from './isdoc';
import { closePdf, openPdf, pdfAttachments } from './pdf';

/** Údaje z první přílohy .isdoc v PDF (data zůstávají v paměti); bez přílohy undefined. */
export async function isdocFacts(docId: string, data: Uint8Array): Promise<DocFacts | undefined> {
  const id = `${docId}-isdoc`;
  await openPdf(id, new Uint8Array(data));
  try {
    for (const a of await pdfAttachments(id)) {
      const facts = parseIsdoc(a.text);
      if (facts) return facts;
    }
  } finally {
    await closePdf(id);
  }
}
