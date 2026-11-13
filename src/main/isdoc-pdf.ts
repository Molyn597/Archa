import type { DocFacts } from '../shared/types';
import { parseIsdoc } from './isdoc';
import { closePdf, openPdf, pdfAttachments } from './pdf';

/** První příloha .isdoc v PDF (data zůstávají v paměti): původní XML a z něj přečtené údaje; bez přílohy undefined. */
async function isdocAttachment(docId: string, data: Uint8Array): Promise<{ xml: string; facts: DocFacts } | undefined> {
  const id = `${docId}-isdoc`;
  await openPdf(id, new Uint8Array(data));
  try {
    for (const a of await pdfAttachments(id)) {
      const facts = parseIsdoc(a.text);
      if (facts) return { xml: a.text, facts };
    }
  } finally {
    await closePdf(id);
  }
}

export const isdocFacts = async (docId: string, data: Uint8Array) => (await isdocAttachment(docId, data))?.facts;
export const isdocXml = async (docId: string, data: Uint8Array) => (await isdocAttachment(docId, data))?.xml;
