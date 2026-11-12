import { fold } from '../shared/folders';
import { t } from '../shared/i18n';
import type { DocumentCard, Job } from '../shared/types';
import { h, icon, ICONS, jobTitle, openModal } from './dom';
import { searchText } from './library';

export interface PaletteCommand {
  label: string;
  icon: string;
  run: () => void;
}

interface Source {
  jobs: () => Job[];
  cards: () => Record<string, DocumentCard>;
  commands: () => PaletteCommand[];
  open: (id: string) => void;
}

const MAX_DOCS = 8;

/** Paleta ⌘K: dokumenty podle hledání v knihovně a příkazy; šipky a Enter, Esc zavře. */
export function openPalette(src: Source) {
  if (document.querySelector('.palette-input')) return;
  const input = h('input', { class: 'palette-input', type: 'search', autocomplete: 'off', placeholder: t('palette.placeholder'), 'aria-label': t('palette.placeholder') });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  let rows: { el: HTMLElement; run: () => void }[] = [];
  let index = 0;

  const mark = () => {
    rows.forEach((r, i) => r.el.classList.toggle('selected', i === index));
    rows[index]?.el.scrollIntoView({ block: 'nearest' });
  };
  const row = (label: string, path: string, run: () => void) => {
    const el = h('button', { class: 'palette-item', type: 'button', role: 'option', onclick: () => (done(), run()) }, icon(path), h('span', {}, label));
    rows.push({ el, run });
    return el;
  };
  let done = () => {};
  const draw = () => {
    const query = fold(input.value.trim());
    const cards = src.cards();
    const docs = src
      .jobs()
      .filter((j) => !query || searchText(j, cards[j.id]).includes(query))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_DOCS);
    const commands = src.commands().filter((c) => !query || fold(c.label).includes(query));
    rows = [];
    index = 0;
    const children: HTMLElement[] = [];
    if (docs.length) children.push(h('div', { class: 'palette-label' }, t('palette.documents')), ...docs.map((j) => row(jobTitle(j), ICONS.file, () => src.open(j.id))));
    if (commands.length) children.push(h('div', { class: 'palette-label' }, t('palette.commands')), ...commands.map((c) => row(c.label, c.icon, c.run)));
    if (!children.length) children.push(h('div', { class: 'palette-label' }, t('palette.empty')));
    list.replaceChildren(...children);
    mark();
  };

  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) index = (index + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const run = rows[index]?.run;
      if (run) (done(), run());
    }
  });

  done = openModal(t('history.search'), [input, list], []);
  draw();
  input.focus();
}
