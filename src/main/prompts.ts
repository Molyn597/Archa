import { englishName } from '../shared/languages';
import type { DocumentContext, GlossaryEntry } from '../shared/types';

export const OCR_PROMPT = 'Convert the document to markdown.';

export const TABLE_PROMPT =
  'Transcribe this table exactly as a Markdown table (| separators, header separator row). ' +
  'Keep the original language and all values. Output only the table.';

export const regionPrompt = (target: string) =>
  `Transcribe all text in this image and translate it into ${englishName(target)}. ` +
  `Translate every title, axis label, legend entry and caption (a figure caption starts with the word for "Figure"); ` +
  `keep numbers, years and proper names. Keep the reading order and line structure; render a table as a Markdown table. ` +
  `Output only the ${englishName(target)} translation, without comments. If there is no text, output nothing.`;

/** TranslateGemma má pevnou šablonu; chat API by její strukturovaný vstup rozbilo, proto raw prompt. */
export function translateGemmaPrompt(text: string, source: string, target: string) {
  const src = englishName(source);
  const tgt = englishName(target);
  return (
    `<start_of_turn>user\nYou are a professional ${src} (${source}) to ${tgt} (${target}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${src} text while adhering to ` +
    `${tgt} grammar, vocabulary, and cultural sensitivities.\nProduce only the ${tgt} translation, without any ` +
    `additional explanations or commentary. Please translate the following ${src} text into ${tgt}:\n\n\n` +
    `${text.trim()}<end_of_turn>\n<start_of_turn>model\n`
  );
}

export const isTranslateGemma = (modelKey: string) => /translategemma/i.test(modelKey);

/**
 * Pro jiné překladové modely než TranslateGemma (chat API, hlavně online). Silnější modely
 * zvládnou delší zadání: rejstřík, co nechat beze změny, kontext dokumentu a závazné termíny.
 */
export function translateSystem(source: string, target: string, glossary: GlossaryEntry[] = [], context?: DocumentContext) {
  const tgt = englishName(target);
  const parts = [
    `You are a professional translator of academic and professional texts from ${englishName(source)} into ${tgt}. ` +
      'Translate the user\'s text faithfully and completely: do not summarize, omit, add or explain anything. ' +
      `Write natural, fluent ${tgt} in a formal academic register and keep terminology consistent.`,
    'Keep unchanged: personal names, citations such as (Smith 2003) or [12], numbers and units, formulas and variable names, URLs, ' +
      'and bibliography entries. Keep paragraph breaks (blank lines), lists and Markdown tables exactly as they are; ' +
      'in a table translate only the text inside the cells.',
  ];
  if (target === 'cs') {
    parts.push(
      'Use Czech typography (quotation marks „…“) and natural Czech word order, not calqued from English. ' +
        'Keep the first person where the author uses it; past-tense verbs referring to a single author agree with the author\'s gender from the context.',
    );
  }
  const lines = contextLines(context, 'en');
  if (lines.length) parts.push(`Document context:\n${lines.join('\n')}`);
  if (glossary.length) parts.push(`Mandatory terminology (use it in the grammatically correct form):\n${glossaryLines(glossary)}`);
  parts.push(`Output only the ${tgt} translation, without any comments.`);
  return parts.join('\n\n');
}

function glossaryLines(glossary: GlossaryEntry[]) {
  return glossary.map((g) => `${g.source} = ${g.target}`).join('\n');
}

const GENDER_CS = { female: 'žena', male: 'muž', unknown: 'neznámý' };

// Termíny z kontextu se korektorovi nepředávají, model je generuje nespolehlivě.
function contextLines(context: DocumentContext | undefined, target: string) {
  if (!context) return [];
  const cs = target === 'cs';
  const lines = [];
  if (context.topic) lines.push(`${cs ? 'Téma' : 'Topic'}: ${context.topic}`);
  if (context.domain) lines.push(`${cs ? 'Obor' : 'Domain'}: ${context.domain}`);
  if (context.author || context.authorGender !== 'unknown') {
    const gender = cs ? GENDER_CS[context.authorGender] : context.authorGender;
    lines.push(`${cs ? 'Autor' : 'Author'}: ${context.author || (cs ? 'neuveden' : 'not stated')} (${cs ? 'rod' : 'gender'}: ${gender})`);
  }
  return lines;
}

/** Korektor opravuje jen nalezené problémy; celotextové uhlazení přidávalo nové chyby. */
export function fixSystem(target: string, glossary: GlossaryEntry[], context?: DocumentContext) {
  const cs = target === 'cs';
  const parts = [
    cs
      ? 'Jsi korektor překladů. Oprav POUZE uvedené problémy, vše ostatní ponech beze změny slovo od slova. Vrať jen opravený text.'
      : 'You are a translation proofreader. Fix ONLY the listed problems, keep everything else unchanged word for word. Output only the corrected text.',
  ];
  const ctx = contextLines(context, target);
  if (ctx.length) parts.push(`${cs ? 'Kontext dokumentu' : 'Document context'}:\n${ctx.join('\n')}`);
  if (glossary.length) {
    parts.push(
      `${cs ? 'Závazná terminologie (použij ji ve správném tvaru)' : 'Mandatory terminology (use it in the grammatically correct form)'}:\n${glossaryLines(glossary)}`,
    );
  }
  return parts.join('\n\n');
}

export function fixUser(source: string, translation: string, problems: string[], target: string) {
  const [o, t, p] = target === 'cs' ? ['ORIGINÁL', 'PŘEKLAD', 'PROBLÉMY'] : ['ORIGINAL', 'TRANSLATION', 'PROBLEMS'];
  return `${o}:\n${source}\n\n${t}:\n${translation}\n\n${p}:\n${problems.map((x) => `- ${x}`).join('\n')}`;
}

export function contextPrompt(sample: string, target: string) {
  return (
    'Read the beginning of the document below and describe it as JSON only, without any other text:\n' +
    '{"topic": "...", "domain": "...", "author": "...", "authorGender": "female" | "male" | "unknown", ' +
    '"audience": "...", "terms": [{"source": "...", "target": "..."}]}\n' +
    `Write topic, domain and audience in ${englishName(target)}. author is the author's name as written, or "" when unknown. ` +
    'authorGender is the gender of the author writing in the first person; use "unknown" when it is not clear. ' +
    `terms are up to 15 key technical terms exactly as written in the document, with their usual ${englishName(target)} translation as target.` +
    `\n\nDOCUMENT:\n${sample}`
  );
}

export function cardPrompt(sample: string, target: string, folders: string[]) {
  const lang = englishName(target);
  return (
    'Read the beginning of the document below and describe it as JSON only, without any other text:\n' +
    '{"summary": "...", "type": "...", "keywords": ["..."], "folder": "...", "folderSure": true, "folderOptions": [], ' +
    '"biblio": {"authors": [{"family": "...", "given": "..."}], "title": "...", "year": "...", "container": "...", ' +
    '"publisher": "...", "place": "...", "edition": "...", "volume": "...", "issue": "...", "pages": "...", "doi": "...", "url": "..."}, ' +
    '"facts": {"subject": "...", "number": "...", "vs": "...", "supplier": "...", "supplierId": "...", "supplierVat": "...", "customer": "...", "customerId": "...", "customerVat": "...", ' +
    '"net": "...", "vat": "...", "amount": "...", "issued": "...", "due": "...", "validFrom": "...", "validTo": "...", "period": "...", "parties": ["..."], "notice": "...", ' +
    '"autoRenewal": "...", "penalty": "...", "law": "..."}}\n' +
    `Write summary (3–5 sentences) and keywords (at most 10) in ${lang}. ` +
    'type must be exactly one of: article, book, chapter, thesis, report, contract, invoice, manual, letter, law, web, other. ' +
    `folder is the library folder for the document, written as a path from this folder tree: ${folders.join('; ')}. ` +
    'Prefer an existing folder. When the document clearly belongs to a narrower topic that has no folder yet, propose a new subfolder ' +
    `under the best fitting existing folder (at most two new levels, e.g. "Studium / Články / Management"), with short names in ${lang}. ` +
    'Choose the most specific folder: never a folder that has subfolders – then pick one of its subfolders or propose a new one under it. ' +
    'Use "" only when nothing fits. folderSure is true when you are confident about folder, false when the document could just as well belong elsewhere; ' +
    'then folderOptions lists 1–2 other plausible folder paths, otherwise []. ' +
    'biblio contains only what is literally stated in the document (title page, header, citation line, DOI); never invent anything and use "" when unknown. ' +
    'Write authors as family and given name; an organisation goes into family with an empty given. ' +
    'container is the journal, proceedings or book the document was published in; pages is the page range in that container. ' +
    'Fill facts only when type is invoice or contract, otherwise use {}; write only what is literally stated in the document, never invent anything, use "" when unknown. ' +
    'For an invoice: number is the invoice number, vs the variable symbol, supplierId/customerId the company registration number (Czech IČO has 8 digits; never a VAT ID), ' +
    'supplierVat/customerVat the VAT ID (DIČ, USt-IdNr., e.g. CZ12345678, DE123456789), net the tax base and vat the VAT amount including currency – only when VAT is stated, ' +
    'amount the total payable including currency. Leave validFrom, validTo, notice, autoRenewal, penalty and law empty for an invoice. ' +
    'For a contract: parties are the contracting parties, amount the price, rent or fee including currency and period (e.g. "18 500 Kč monthly"), issued the signing date, ' +
    'validFrom/validTo the validity dates, notice the notice period, autoRenewal briefly whether and how it renews automatically, penalty briefly the contractual penalties, ' +
    'law the governing law. Leave number, vs, supplier, customer, their IDs, net, vat and due empty for a contract. ' +
    `Write dates as YYYY-MM-DD, amounts including their currency, subject, autoRenewal and penalty briefly in ${lang}.` +
    `\n\nDOCUMENT:\n${sample}`
  );
}

/** Klíčová slova pro hledání v dokumentu v obou jazycích (dotaz česky na anglický originál). */
export const searchTermsPrompt = (question: string, source: string, target: string) =>
  `A user asks about a document written in ${englishName(source)} and translated into ${englishName(target)}.\n` +
  `Question: ${question}\n\n` +
  `Write 10–20 search keywords and short phrases that passages answering this question would contain, ` +
  `in both ${englishName(source)} and ${englishName(target)}, including synonyms and related technical terms. ` +
  'Output only the keywords separated by commas.';

export const DOCUMENT_CHAT_SYSTEM =
  'You answer questions about one document using only the numbered passages below (p. = page). Rules:\n' +
  '- Use only information from the passages, never outside knowledge. If they do not contain the answer, say so in one sentence.\n' +
  '- After each sentence based on a passage, cite it by its number in square brackets, e.g. [12]; several as [12][15]. ' +
  'Cite only numbers that appear below.\n' +
  '- Answer in the language of the question, concisely and in your own words; quote only short phrases.\n' +
  '- For a summary, cover the main points in the order of the document.\n\nPassages:\n';

/**
 * Chat s knihovnou, krok 1: z katalogu karet vybrat dokumenty, navrhnout hledací slova,
 * u příliš vágního dotazu doplňující otázku.
 */
export const libraryRoutePrompt = (question: string, catalog: string, langs: string[], previous?: string, tree: string[] = [], focus: number[] = []) =>
  'A user searches their personal library of documents (invoices, contracts, articles, letters …).\n' +
  (previous ? `Their previous question was: ${previous}\n` : '') +
  `Question: ${question}\n\n` +
  'Catalog of the library, one document per line: [id] file name | folder | type | year | title | summary | keywords | facts.\n' +
  `${catalog}\n\n` +
  (tree.length ? `Folder tree: ${tree.join('; ')}\n\n` : '') +
  (focus.length ? `The user is now looking at documents ${focus.map((n) => `[${n}]`).join(', ')}; "this", "it" or "these" mean them unless the question names other documents.\n\n` : '') +
  'Answer with JSON only, without any other text:\n' +
  '{"action": "search", "scope": "", "docs": [1, 5], "terms": ["..."], "clarify": ""}\n' +
  'action: "organize" when the user wants documents sorted, organised, filed or moved into folders or subfolders, ' +
  'or asks where a document belongs or should be moved (e.g. "kam bys to zařadil", "where would you put this"); otherwise "search". ' +
  'For "organize" about particular documents (also "this", "it" from the previous question), list them in docs. ' +
  'scope: for "organize" of a whole folder, its path from the folder tree; "" otherwise.\n' +
  'docs: ids of documents most likely to contain the answer, best first, at most 8; [] when none fits. ' +
  'Prefer documents whose type, facts, dates and summary match the question.\n' +
  `terms: 10–20 search keywords and short phrases that passages answering the question would contain, in ${langs.map(englishName).join(' and ')}, including synonyms.\n` +
  'clarify: only when the question is too vague to search (e.g. no subject at all), a short question in the language of the user asking what they mean; otherwise "".';

export const LIBRARY_CHAT_SYSTEM =
  "You answer questions about the user's document library using only the numbered passages below (p. = page). " +
  'Passages are grouped by document; a passage starting with "## Document:" names the document and may list facts from its card. Rules:\n' +
  '- Use only information from the passages, never outside knowledge. If they do not contain the answer, say so plainly in one sentence ' +
  'and suggest how to make the question more specific (time period, name, type of document). If you are not sure, say what is uncertain.\n' +
  '- After each sentence based on a passage, cite it by its number in square brackets, e.g. [12]; several as [12][15]. Cite only numbers that appear below.\n' +
  '- Name the document(s) the answer comes from.\n' +
  '- Answer in the language of the question, concisely and in your own words; quote only short phrases.\n\nPassages:\n';

/**
 * Chat projektu: jen úseky zdrojů projektu, zadání a osnova jako kontext. Smí psát návrhy textu (rozhodnutí uživatele),
 * ale každé převzaté tvrzení musí citovat úsek; co zdroje nepodloží, řekne místo vymýšlení.
 */
export const projectChatSystem = (kind: string, name: string, assignment: string, outline: string) =>
  `You help the user work on their project: ${kind} "${name}".\n` +
  (assignment.trim() ? `Assignment:\n${assignment.trim().slice(0, 3000)}\n` : '') +
  (outline.trim() ? `Outline:\n${outline.trim().slice(0, 3000)}\n` : '') +
  'Below are numbered passages from the sources the user chose for this project (p. = page); a passage starting with "## Document:" names the document. Rules:\n' +
  '- Answer questions, explain and compare the sources, suggest structure and write draft text (paragraphs, chapter sections) when asked. ' +
  'Do it directly, without remarks about academic integrity or who should write the text.\n' +
  '- Every sentence that uses a fact, finding, number or idea from a passage must cite it by its number in square brackets, e.g. [12]; several as [12][15]. Cite only numbers that appear below.\n' +
  '- Never invent facts, numbers, authors or quotes. If the passages do not support something the answer or draft needs, say plainly which part has no source instead of making it up.\n' +
  '- Write in the language of the question, in your own words; quote only short phrases, in quotation marks and with a citation. Name the documents when comparing sources.\n\nPassages:\n';

/** Návrh roztřídění dokumentů do (pod)složek; `scope` = cesta složky, jinak celá knihovna. */
export const organizePrompt = (tree: string[], scope: string, catalog: string, lang: string, instruction?: string) =>
  'You organise a personal library of documents into folders and subfolders.\n' +
  (instruction ? `The user asks: ${instruction}\n` : '') +
  `Existing folder tree: ${tree.join('; ') || '(none)'}\n` +
  (scope ? `Organise only inside the folder "${scope}"; every path must start with "${scope} / ".\n` : '') +
  'Documents, one per line: [id] file name | current folder | type | year | title | summary | keywords | facts.\n' +
  `${catalog}\n\n` +
  'Group the documents by topic. Reuse existing folders where they fit; create a new folder only for a topic with at least 2 documents, ' +
  'unless the user asks about particular documents or asks for new folders – then propose the best specific subfolder even for one document. ' +
  `Use short folder names in ${englishName(lang)}, at most 2 new levels.\n` +
  'Answer with JSON only, without any other text:\n' +
  '{"folders": [{"path": "Studium / Články / Management", "docs": [1, 2]}], "questions": [{"doc": 3, "options": ["...", "..."]}]}\n' +
  'Never put a document directly into a folder that has subfolders – use one of the subfolders or a new one; documents lying directly in such a folder need a subfolder too. ' +
  'Put each document into at most one folder and leave out documents that already fit their current folder. ' +
  'When you are not sure where a document belongs, do not put it into folders; list it in questions with 2–3 plausible folder paths.';

/** Doptání: navržená složka má podsložky, dokument patří do některé z nich (nebo do nové pod ní). */
export const subfolderPrompt = (summary: string, keywords: string[], path: string, children: string[], lang: string) =>
  `A document should be filed in the library folder "${path}", which has these subfolders: ${children.join('; ')}.\n` +
  `Document summary: ${summary}\nKeywords: ${keywords.join(', ')}\n\n` +
  `Choose the best fitting subfolder. If none fits, propose a new subfolder of "${path}" with a short name in ${englishName(lang)}. ` +
  'Never answer the folder itself.\n' +
  'Answer with JSON only, without any other text: {"folder": "<full path>", "folderSure": true, "folderOptions": []}\n' +
  'folderSure is false when the document could just as well belong to another subfolder; then folderOptions lists 1–2 other full paths.';

/** Návrh sloučení složek se stejným významem (synonyma, jednotné/množné číslo, jiný jazyk). */
export const mergePrompt = (tree: string, lang: string) =>
  'Below is the folder tree of a personal document library; each line is a folder path and the number of documents in it, including subfolders.\n' +
  `${tree}\n\n` +
  'Find folders that mean the same thing and should be merged: synonyms, singular and plural, the same topic in another language, or near-duplicates. ' +
  'Do not merge folders that are only related (e.g. "Economics" and "Management") or a folder with its own subfolder.\n' +
  `Answer with JSON only, without any other text: {"merges": [{"from": "<path>", "into": "<path>", "reason": "<short reason in ${englishName(lang)}>"}]}. ` +
  'into is the folder to keep, usually the one with more documents; use [] when nothing should be merged.';
