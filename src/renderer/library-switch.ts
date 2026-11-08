import { t } from '../shared/i18n';
import { parseSubjects } from '../shared/library-templates';
import type { Libraries, LibraryInfo, LibraryKind } from '../shared/types';
import { cleanError, h, icon, ICONS, openModal, toast } from './dom';

const KINDS: LibraryKind[] = ['work', 'study', 'personal'];

let libs: Libraries | undefined;

/** Zobrazený název knihovny: vlastní, jinak název typu. */
export const libraryTitle = (l: LibraryInfo) => l.name || t(`libraryKind.${l.kind}`);

const current = () => libs?.list.find((l) => l.id === libs!.current);

/** Okno s typem, názvem (volitelným) a u Studia předměty; po potvrzení knihovnu založí a přepne na ni. */
function newLibraryModal() {
  const kind = h('select', { 'aria-label': t('libs.kind') }, ...KINDS.map((k) => h('option', { value: k }, t(`libraryKind.${k}`))));
  const name = h('input', { type: 'text', maxlength: '60', 'aria-label': t('libs.name') });
  const subjects = h('input', { type: 'text', placeholder: t('welcome.libraries.subjectsHint'), 'aria-label': t('welcome.libraries.subjects') });
  const subjectsRow = h('label', { class: 'proj-field' }, h('span', { class: 'muted small' }, t('welcome.libraries.subjects')), subjects);
  const sync = () => {
    name.placeholder = t(`libraryKind.${kind.value as LibraryKind}`);
    subjectsRow.hidden = kind.value !== 'study';
  };
  kind.addEventListener('change', sync);
  sync();
  let close = () => {};
  const submit = async () => {
    close();
    const k = kind.value as LibraryKind;
    try {
      await window.api.createLibrary(k, name.value.trim() || undefined, k === 'study' ? parseSubjects(subjects.value) : undefined);
    } catch (e) {
      toast(cleanError(e), true);
    }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && void submit());
  close = openModal(
    t('libs.newTitle'),
    [
      h('label', { class: 'proj-field' }, h('span', { class: 'muted small' }, t('libs.kind')), kind),
      h('label', { class: 'proj-field' }, h('span', { class: 'muted small' }, t('libs.name')), name),
      subjectsRow,
    ],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('libs.cancel')), h('button', { class: 'btn primary', type: 'button', onclick: () => void submit() }, t('libs.create'))],
  );
  name.focus();
}

function renameLibraryModal(info: LibraryInfo) {
  const name = h('input', { type: 'text', maxlength: '60', value: info.name ?? '', placeholder: t(`libraryKind.${info.kind}`), 'aria-label': t('libs.name') });
  let close = () => {};
  const submit = async () => {
    close();
    try {
      libs = await window.api.renameLibrary(info.id, name.value.trim());
      document.dispatchEvent(new CustomEvent('libraries-changed'));
    } catch (e) {
      toast(cleanError(e), true);
    }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && void submit());
  close = openModal(
    t('libs.renameTitle'),
    [h('label', { class: 'proj-field' }, h('span', { class: 'muted small' }, t('libs.name')), name)],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('libs.cancel')), h('button', { class: 'btn primary', type: 'button', onclick: () => void submit() }, t('libs.save'))],
  );
  name.focus();
  name.select();
}

async function switchTo(id: string) {
  try {
    await window.api.switchLibrary(id);
  } catch (e) {
    toast(cleanError(e), true);
  }
}

function render() {
  const box = document.getElementById('lib-switch')!;
  const cur = current();
  if (!libs || !cur) {
    box.replaceChildren();
    return;
  }
  // Víc knihoven = v titulku okna je vidět, která je otevřená.
  document.title = libs.list.length > 1 ? `TransLatte – ${libraryTitle(cur)}` : 'TransLatte';
  const name = libraryTitle(cur);
  const menu = h(
    'div',
    { class: 'menu', hidden: true },
    ...libs.list.map((l) => h('button', { type: 'button', onclick: () => void (l.id !== cur.id && switchTo(l.id)) }, l.id === cur.id ? icon(ICONS.check) : h('span', { class: 'menu-gap' }), libraryTitle(l))),
    h('div', { class: 'menu-sep' }),
    h('button', { type: 'button', onclick: newLibraryModal }, icon(ICONS.plus), t('libs.new')),
    h('button', { type: 'button', onclick: () => renameLibraryModal(cur) }, h('span', { class: 'menu-gap' }), t('libs.rename')),
  );
  const button = h(
    'button',
    {
      class: 'lib-switch-btn',
      type: 'button',
      title: name,
      'aria-label': t('libs.switch'),
      'aria-haspopup': 'menu',
      onclick: (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
        menu.hidden = !open;
      },
    },
    h('span', { class: 'lib-badge' }, [...name][0]?.toUpperCase() ?? ''),
    h('span', { class: 'lib-name' }, name),
    icon(ICONS.chevron),
  );
  // Volba v nabídce ji zavře; kliknutí mimo zavře obecný obslužný kód knihovny.
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = true;
  });
  box.replaceChildren(button, menu);
}

/** Načte knihovny a překreslí přepínač (po změně se volá znovu). */
export async function refreshLibrarySwitch() {
  libs = await window.api.libraries().catch(() => libs);
  render();
  return libs;
}

export function setupLibrarySwitch() {
  document.addEventListener('libraries-changed', () => void refreshLibrarySwitch());
  return refreshLibrarySwitch();
}
