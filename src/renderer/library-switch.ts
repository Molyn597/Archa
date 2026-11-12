import { t, type MessageKey } from '../shared/i18n';
import { parseSubjects } from '../shared/library-templates';
import type { StudyOffer } from '../shared/library-transfer';
import type { Libraries, LibraryInfo, LibraryKind, MoveOptions } from '../shared/types';
import { cleanError, h, icon, ICONS, openModal, toast } from './dom';

const KINDS: LibraryKind[] = ['work', 'study', 'personal'];
const KIND_ICON: Record<LibraryKind, string> = { work: ICONS.briefcase, study: ICONS.cap, personal: ICONS.home, general: ICONS.briefcase };

/** Barevná ikona typu knihovny (barvy --lib-work / --lib-study / --lib-personal). */
const avatar = (kind: LibraryKind) => h('span', { class: `lib-avatar ${kind === 'general' ? 'work' : kind}` }, icon(KIND_ICON[kind]));

let libs: Libraries | undefined;

/** Zobrazený název knihovny: vlastní, jinak název typu. */
export const libraryTitle = (l: LibraryInfo) => l.name || t(`libraryKind.${l.kind}`);

const current = () => libs?.list.find((l) => l.id === libs!.current);

/** Existuje aspoň jedna jiná knihovna, kam jde dokumenty přesunout. */
export const hasOtherLibrary = () => (libs?.list.length ?? 0) > 1;

async function applyKind(info: LibraryInfo, kind: LibraryKind) {
  try {
    libs = await window.api.setLibraryKind(info.id, kind);
    document.dispatchEvent(new CustomEvent('libraries-changed'));
  } catch (e) {
    toast(cleanError(e), true);
  }
}

/** Volba typu knihovny: tři dlaždice s popisem; `text` doplní vysvětlení, `later` přidá tlačítko Později. */
function kindModal(info: LibraryInfo, title: string, later?: () => void) {
  let close = () => {};
  const choice = (k: LibraryKind) =>
    h(
      'button',
      {
        class: `kind-option${info.kind === k ? ' selected' : ''}`,
        type: 'button',
        onclick: () => {
          close();
          void applyKind(info, k);
        },
      },
      h('strong', {}, t(`libraryKind.${k}`)),
      h('span', { class: 'muted small' }, t(`welcome.libraries.${k}.desc` as MessageKey)),
    );
  close = openModal(
    title,
    [h('p', {}, t('libs.typeText')), h('div', { class: 'proj-field' }, ...KINDS.map(choice))],
    [h('button', { class: 'btn', type: 'button', onclick: () => (close(), later?.()) }, later ? t('libs.typeLater') : t('libs.cancel'))],
  );
}

/** Převzatá knihovna bez typu: dotaz při otevření. Vrací, zda se dialog ukázal. */
export async function promptLibraryKind() {
  const libs = await refreshLibrarySwitch();
  const cur = libs?.list.find((l) => l.id === libs.current);
  if (!cur || cur.kind !== 'general') return false;
  kindModal(cur, t('libs.typeTitle'), () => undefined);
  return true;
}

/** Typ otevřené knihovny a první studijní knihovna (cíl nabídky přesunu článků a knih). */
export const currentKind = () => current()?.kind;
export const studyLibrary = () => libs?.list.find((l) => l.kind === 'study' && l.id !== libs!.current);

async function runMove(ids: string[], target: LibraryInfo, opts: MoveOptions) {
  try {
    const count = await window.api.moveToLibrary(ids, target.id, opts);
    toast(t('libs.moved', { name: libraryTitle(target), count }));
  } catch (e) {
    toast(cleanError(e), true);
  }
}

/** Věty o studijních věcech k přesunu: „8 článků a knih, 1 bakalářská práce“. */
export function studyText(key: 'libs.studyOffer' | 'libs.studyConfirm', offer: StudyOffer) {
  const study = studyLibrary();
  const parts = [offer.literature && t('libs.studyLit', { count: offer.literature }), offer.projectIds.length && t('libs.studyProj', { count: offer.projectIds.length })].filter(Boolean).join(', ');
  return t(key, { parts, library: study ? libraryTitle(study) : t('libraryKind.study') }) + (offer.skipped ? ` ${t('libs.studySkipped', { count: offer.skipped })}` : '');
}

/**
 * Přesun studijních věcí (články a knihy, studijní projekty se zdroji; vše se strukturou složek) do studijní knihovny
 * po potvrzení; bez ní ji nejdřív založí (bez přepnutí, ať zdrojová knihovna zůstane otevřená).
 */
export async function moveStudy(offer: StudyOffer, done?: () => void) {
  let target = studyLibrary();
  if (!confirm(studyText('libs.studyConfirm', offer))) return;
  try {
    if (!target) {
      target = await window.api.createLibrary('study', undefined, undefined, true);
      await refreshLibrarySwitch();
    }
  } catch (e) {
    toast(cleanError(e), true);
    return;
  }
  await runMove(offer.ids, target, { keepFolders: true, projectIds: offer.projectIds });
  done?.();
}

/**
 * Výběr cílové knihovny pro přesun dokumentů (se strukturou složek); po přesunu toast s počtem.
 * S `folder` se přesouvá celá složka: po potvrzení se přesunou její dokumenty a prázdná složka ve zdroji zmizí.
 */
export function moveToLibraryModal(ids: string[], done?: () => void, folder?: { id: string; name: string }) {
  const targets = libs?.list.filter((l) => l.id !== libs!.current) ?? [];
  if (!targets.length || !ids.length) return;
  let close = () => {};
  const pick = async (l: LibraryInfo) => {
    close();
    if (folder && !confirm(t('libs.moveFolderConfirm', { name: folder.name, count: ids.length, library: libraryTitle(l) }))) return;
    await runMove(ids, l, { keepFolders: true, fromFolder: folder?.id });
    done?.();
  };
  close = openModal(
    t('libs.moveTitle'),
    [
      h('p', {}, t('libs.moveText', { count: ids.length })),
      h('div', { class: 'proj-field' }, ...targets.map((l) => h('button', { class: 'kind-option', type: 'button', onclick: () => void pick(l) }, h('strong', {}, libraryTitle(l)), h('span', { class: 'muted small' }, t(`libraryKind.${l.kind}`))))),
    ],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('libs.cancel'))],
  );
}

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
    ...libs.list.map((l) => h('button', { type: 'button', onclick: () => void (l.id !== cur.id && switchTo(l.id)) }, avatar(l.kind), h('span', { class: 'menu-grow' }, libraryTitle(l)), l.id === cur.id && icon(ICONS.check))),
    h('div', { class: 'menu-sep' }),
    h('button', { type: 'button', onclick: newLibraryModal }, icon(ICONS.plus), t('libs.new')),
    h('button', { type: 'button', onclick: () => renameLibraryModal(cur) }, h('span', { class: 'menu-gap' }), t('libs.rename')),
    ...libs.list.map((l) => h('button', { type: 'button', onclick: () => kindModal(l, t('libs.type').replace('…', '')) }, h('span', { class: 'menu-gap' }), libs!.list.length > 1 ? `${t('libs.type')} – ${libraryTitle(l)}` : t('libs.type'))),
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
    avatar(cur.kind),
    h('span', { class: 'lib-text' }, h('span', { class: 'lib-name' }, name), name !== t(`libraryKind.${cur.kind}`) && h('span', { class: 'lib-kind' }, t(`libraryKind.${cur.kind}`))),
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
