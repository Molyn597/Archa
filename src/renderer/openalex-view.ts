import { t, type MessageKey } from '../shared/i18n';
import { applyGaps, toBiblio, type FillField, type Gap, type OpenAlexWork } from '../shared/openalex';
import type { DocumentCard } from '../shared/types';
import { cleanError, h, icon, ICONS, openModal, toast } from './dom';

const LISTED_AUTHORS = 3;

const fieldLabel = (f: FillField) => t(f === 'authors' ? 'card.authors' : (`card.biblio.${f}` as MessageKey));

/** První autoři z výsledku: „Becker, Mincer, Schultz a kol.“ */
function authorLine(work: OpenAlexWork) {
  const names = work.authors.slice(0, LISTED_AUTHORS).map((a) => a.family);
  return names.join(', ') + (work.authors.length > LISTED_AUTHORS ? ` ${t('openalex.etAl')}` : '');
}

/** Hledání zdrojů v OpenAlex; dotaz odchází až po kliknutí na Hledat nebo Enter. Se `projectId` jdou přidané dokumenty i do zdrojů projektu. */
export function openOpenAlex(query = '', projectId?: string) {
  const input = h('input', { type: 'search', class: 'oa-input', autocomplete: 'off', placeholder: t('openalex.placeholder'), 'aria-label': t('openalex.placeholder') });
  input.value = query;
  const list = h('div', { class: 'oa-list', hidden: true });
  const status = h('p', { class: 'muted small oa-status', hidden: true });
  const go = h('button', { class: 'btn primary', type: 'button' }, icon(ICONS.search), t('openalex.search'));

  const row = (work: OpenAlexWork) => {
    const meta = [authorLine(work), work.year, work.container].filter(Boolean).join(' · ');
    const actions = h('div', { class: 'oa-actions' });
    if (work.pdfUrl) {
      const add = h('button', { class: 'btn', type: 'button' }, t('openalex.add'));
      add.onclick = async () => {
        add.disabled = true;
        add.textContent = t('openalex.adding');
        try {
          await window.api.openalexAdd(work, projectId);
          add.textContent = t('openalex.added');
          toast(t(projectId ? 'openalex.addedProject' : 'openalex.addedToast'));
        } catch (e) {
          add.disabled = false;
          add.textContent = t('openalex.add');
          toast(cleanError(e), true);
        }
      };
      actions.append(add);
    }
    const link = work.url ?? (work.doi ? `https://doi.org/${work.doi}` : undefined);
    if (link) actions.append(h('button', { class: 'btn', type: 'button', onclick: () => void window.api.openWeb(link).catch((e) => toast(cleanError(e), true)) }, t('openalex.open')));
    return h(
      'div',
      { class: 'oa-row' },
      h('div', { class: 'oa-main' }, h('div', { class: 'job-row-name' }, work.title), meta ? h('div', { class: 'job-row-meta' }, meta) : null, work.pdfUrl ? h('span', { class: 'chip ok' }, t('openalex.pdfFree')) : null),
      actions,
    );
  };

  let token = 0;
  const search = async () => {
    const q = input.value.trim();
    if (!q) return;
    const mine = ++token;
    go.disabled = true;
    list.hidden = true;
    status.hidden = false;
    status.textContent = t('openalex.searching');
    try {
      const works = await window.api.openalexSearch(q);
      if (mine !== token) return;
      list.replaceChildren(...works.map(row));
      list.hidden = !works.length;
      status.hidden = !!works.length;
      status.textContent = t('openalex.empty');
    } catch (e) {
      if (mine !== token) return;
      status.hidden = true;
      toast(cleanError(e), true);
    } finally {
      if (mine === token) go.disabled = false;
    }
  };
  go.onclick = () => void search();
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void search());

  const close = openModal(t('openalex.find'), [h('div', { class: 'oa-search' }, input, go), h('p', { class: 'muted small' }, t('openalex.privacy')), status, list], [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('region.close'))]);
  input.focus();
}

/** Nabídne doplnění prázdných polí karty z OpenAlex; vybraná pole uloží přes úpravu karty a zavolá `done`. */
export async function openFill(jobId: string, card: DocumentCard, done: (saved: DocumentCard) => void) {
  const found = await window.api.openalexLookup(jobId);
  if (!found) return toast(t('openalex.fillNotFound'), true);
  if (!found.gaps.length) return toast(t('openalex.fillNothing'));
  const boxes = found.gaps.map((g: Gap) => {
    const box = h('input', { type: 'checkbox', class: 'lib-check' });
    box.checked = true;
    return { gap: g, box };
  });
  const rows = boxes.map(({ gap, box }) =>
    h('label', { class: 'oa-fill-row' }, box, h('span', {}, h('div', { class: 'job-row-meta' }, fieldLabel(gap.field)), h('div', { class: 'oa-found' }, gap.found))),
  );
  const apply = h('button', { class: 'btn primary', type: 'button' }, t('openalex.fillSelected'));
  const close = openModal(t('openalex.fillTitle'), [h('p', { class: 'merge-hint' }, t('openalex.fillIntro', { title: found.work.title })), h('div', { class: 'oa-fill' }, ...rows)], [
    h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('project.cancel')),
    apply,
  ]);
  apply.onclick = async () => {
    const only = boxes.filter(({ box }) => box.checked).map(({ gap }) => gap.field);
    if (!only.length) return close();
    apply.disabled = true;
    const saved: DocumentCard = { ...card, biblio: applyGaps(card.biblio, toBiblio(found.work), only) };
    try {
      await window.api.saveCard(jobId, saved);
      close();
      toast(t('openalex.fillDone'));
      done({ ...saved, edited: true });
    } catch (e) {
      apply.disabled = false;
      toast(cleanError(e), true);
    }
  };
}
