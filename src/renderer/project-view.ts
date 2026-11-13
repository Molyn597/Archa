import { getLang, t, type MessageKey } from '../shared/i18n';
import { bibliography, bibliographyHtml, bibliographyText, type BiblioEntry } from '../shared/bibliography';
import { citeLang, isStudy, kindName, PROJECT_KINDS } from '../shared/projects';
import type { CitationStyle, DocumentCard, Job, Project, ProjectKind } from '../shared/types';
import type { Tab } from './detail';
import { openChat } from './chat';
import { actionMenu, cleanError, h, icon, ICONS, openModal, toast, writeClipboard } from './dom';
import { openOpenAlex } from './openalex-view';
import { filterSources } from './project-filter';
import { openPractice } from './practice-view';

/** Co detail projektu potřebuje od knihovny (data, otevření dokumentu, nahrazení kopie projektu). */
export interface ProjectCtx {
  get(id: string): Project | undefined;
  /** Nahradí uloženou kopii projektu a překreslí knihovnu. */
  put(project: Project): void;
  jobs(): Job[];
  trash(): Job[];
  cards(): Record<string, DocumentCard>;
  folderLabel(jobId: string): string;
  open(id: string, tab?: Tab): void;
  remove(id: string): void;
  reload(): void;
}

type ProjectTab = 'sources' | 'brief' | 'notes' | 'bibliography';
type TextField = 'assignment' | 'outline' | 'notes';

const TAB_KEY = 'projectTab';
const SAVE_DELAY = 600;
const TABS: ProjectTab[] = ['sources', 'brief', 'notes', 'bibliography'];

let tab: ProjectTab = 'sources';
try {
  const saved = localStorage.getItem(TAB_KEY) as ProjectTab | null;
  if (saved && TABS.includes(saved)) tab = saved;
} catch {}

// Rozepsané texty čekající na uložení (vždy jen jednoho projektu), fronta uložení a poslední kontext.
let dirty: Partial<Record<TextField, string>> = {};
let dirtyId = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let status: HTMLElement | null = null;
let ctx: ProjectCtx | null = null;

const setStatus = (text: string) => status && (status.textContent = text);

/** Uloží změny projektu (po jednom, ve frontě); vrací kopii z disku do knihovny. */
function save(id: string, patch: Partial<Project>) {
  const c = ctx;
  queue = queue.then(async () => {
    const current = c?.get(id);
    if (!c || !current) return;
    try {
      c.put(await window.api.saveProject({ ...current, ...patch }));
      setStatus(t('project.saved'));
    } catch (e) {
      toast(cleanError(e), true);
      setStatus('');
    }
  });
  return queue;
}

/** Okamžitě uloží rozepsané texty; volá se při opuštění projektu nebo okna. */
export function flushProject() {
  clearTimeout(timer);
  const id = dirtyId;
  const patch = dirty;
  dirty = {};
  dirtyId = '';
  if (id && Object.keys(patch).length) void save(id, patch);
}

function schedule(id: string, field: TextField, value: string) {
  if (dirtyId && dirtyId !== id) flushProject();
  dirtyId = id;
  dirty[field] = value;
  setStatus(t('project.saving'));
  clearTimeout(timer);
  timer = setTimeout(flushProject, SAVE_DELAY);
}

const authors = (card?: DocumentCard) =>
  (card?.biblio.authors ?? [])
    .map((a) => [a.given, a.family].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');

const titleOf = (job: Job, card?: DocumentCard) => card?.biblio.title?.trim() || `${job.name}${job.ext}`;

// ---------- Dialog nového projektu ----------

/** Dialog s názvem a druhem; po potvrzení zavolá `onCreate`. */
export function newProjectModal(onCreate: (name: string, kind: ProjectKind) => void) {
  const name = h('input', { type: 'text', placeholder: t('project.namePlaceholder'), maxlength: '80', 'aria-label': t('project.name') });
  const kind = h('select', { 'aria-label': t('project.kind') }, ...PROJECT_KINDS.map((k) => h('option', { value: k }, kindName(k))));
  let close = () => {};
  const submit = () => {
    close();
    onCreate(name.value.trim(), kind.value as ProjectKind);
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  close = openModal(
    t('project.new'),
    [h('label', { class: 'proj-field' }, h('span', { class: 'muted small' }, t('project.name')), name), h('label', { class: 'proj-field' }, h('span', { class: 'muted small' }, t('project.kind')), kind)],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('project.cancel')), h('button', { class: 'btn primary', type: 'button', onclick: submit }, t('project.create'))],
  );
  name.focus();
}

// ---------- Výběr projektu (hromadné přidání z knihovny) ----------

/** Okno se seznamem projektů; klik na projekt (nebo Nový projekt) ho zavře a zavolá `onPick` s id, nebo `null` pro nový. */
export function pickProjectModal(projects: Project[], count: number, onPick: (id: string | null) => void) {
  let close = () => {};
  const pick = (id: string | null) => {
    close();
    onPick(id);
  };
  const rows = projects.map((p) =>
    h(
      'button',
      { class: 'proj-choice', type: 'button', onclick: () => pick(p.id) },
      icon(ICONS.book),
      h('span', {}, h('div', { class: 'job-row-name' }, p.name), h('div', { class: 'job-row-meta' }, `${kindName(p.kind)} · ${t('project.sourceCount', { count: p.sources.length })}`)),
    ),
  );
  const fresh = h('button', { class: 'proj-choice proj-choice-new', type: 'button', onclick: () => pick(null) }, icon(ICONS.plus), h('span', {}, h('div', { class: 'job-row-name' }, t('project.new'))));
  close = openModal(
    t('project.addToTitle', { count }),
    [h('div', { class: 'proj-choices' }, ...rows, fresh)],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('project.cancel'))],
  );
}

// ---------- Výběr zdrojů z knihovny ----------

function pickSources(p: Project, c: ProjectCtx) {
  const have = new Set(p.sources);
  const picked = new Set<string>();
  const items = c.jobs().map((job) => ({ job, card: c.cards()[job.id] }));
  const search = h('input', { type: 'search', placeholder: t('project.search'), 'aria-label': t('project.search') });
  const list = h('div', { class: 'proj-pick' });
  const add = h('button', { class: 'btn primary', type: 'button', disabled: true }, t('project.addCount', { count: 0 }));
  const draw = () => {
    const shown = filterSources(items, search.value);
    list.replaceChildren(
      ...(shown.length
        ? shown.map(({ job, card }) => {
            const box = h('input', { type: 'checkbox', class: 'lib-check' });
            box.checked = have.has(job.id) || picked.has(job.id);
            box.disabled = have.has(job.id);
            box.addEventListener('change', () => {
              if (box.checked) picked.add(job.id);
              else picked.delete(job.id);
              add.disabled = !picked.size;
              add.textContent = t('project.addCount', { count: picked.size });
            });
            const meta = [authors(card), card?.biblio.year].filter(Boolean).join(' · ');
            return h('label', { class: `proj-pick-row${have.has(job.id) ? ' dim' : ''}` }, box, h('span', {}, h('div', { class: 'job-row-name' }, titleOf(job, card)), meta ? h('div', { class: 'job-row-meta' }, meta) : null), have.has(job.id) ? h('span', { class: 'chip' }, t('project.alreadyAdded')) : null);
          })
        : [h('p', { class: 'muted small' }, t('project.pickEmpty'))]),
    );
  };
  search.addEventListener('input', draw);
  draw();
  const close = openModal(t('project.addTitle'), [search, list], [
    h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('project.cancel')),
    add,
  ]);
  add.addEventListener('click', () => {
    close();
    void window.api.addToProject(p.id, [...picked]).then(c.put, (e) => toast(cleanError(e), true));
  });
  search.focus();
}

// ---------- Záložky ----------

function sourcesTab(p: Project, c: ProjectCtx) {
  const jobs = c.jobs();
  const trashed = c.trash();
  const drop = (id: string) => void save(p.id, { sources: p.sources.filter((s) => s !== id) });
  const removeBtn = (id: string) => h('button', { class: 'btn icon-only', type: 'button', title: t('project.remove'), 'aria-label': t('project.remove'), onclick: () => drop(id) }, icon(ICONS.x));
  const rows = p.sources.map((id) => {
    const job = jobs.find((j) => j.id === id);
    if (job) {
      const card = c.cards()[id];
      const meta = [authors(card), card?.biblio.year, c.folderLabel(id)].filter(Boolean).join(' · ');
      return h('div', { class: 'lib-item' }, h('div', { class: 'lib-line' }, h('button', { class: 'job-row', type: 'button', onclick: () => c.open(id) }, h('span', {}, h('div', { class: 'job-row-name' }, titleOf(job, card)), meta ? h('div', { class: 'job-row-meta' }, meta) : null)), removeBtn(id)));
    }
    const gone = trashed.find((j) => j.id === id);
    if (gone) {
      const restore = h('button', { class: 'btn', type: 'button', onclick: () => void window.api.restoreJobs([id]).catch((e) => toast(cleanError(e), true)) }, t('project.restore'));
      return h('div', { class: 'lib-item dim' }, h('div', { class: 'lib-line' }, h('div', { class: 'proj-gone' }, h('div', { class: 'job-row-name' }, `${gone.name}${gone.ext}`), h('span', { class: 'chip' }, t('project.inTrash'))), restore, removeBtn(id)));
    }
    // Bez názvu: zamčený dokument by ho při zamčeném trezoru neměl prozradit.
    return h('div', { class: 'lib-item dim' }, h('div', { class: 'lib-line' }, h('div', { class: 'proj-gone' }, h('span', { class: 'muted' }, t('project.unavailable'))), removeBtn(id)));
  });
  const add = h('button', { class: 'btn', type: 'button', onclick: () => pickSources(p, c) }, icon(ICONS.plus), t('project.addSources'));
  const online = isStudy(p.kind) ? h('button', { class: 'btn', type: 'button', onclick: () => openOpenAlex(p.name, p.id) }, icon(ICONS.globe), t('openalex.findShort')) : null;
  return h('div', {}, h('div', { class: 'proj-actions' }, add, online), rows.length ? h('div', { class: 'proj-list' }, ...rows) : h('p', { class: 'muted' }, t('project.sourcesEmpty')));
}

function textArea(p: Project, field: TextField, placeholder: string, label?: string) {
  const area = h('textarea', { class: `proj-text${field === 'outline' ? ' mono' : ''}`, placeholder, spellcheck: field === 'outline' ? 'false' : 'true', 'aria-label': label ?? placeholder });
  area.value = p[field];
  area.addEventListener('input', () => schedule(p.id, field, area.value));
  if (field === 'outline') {
    area.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    });
  }
  return area;
}

function briefTab(p: Project) {
  return h(
    'div',
    { class: 'proj-brief' },
    h('label', { class: 'proj-field' }, h('strong', {}, t('project.assignment')), textArea(p, 'assignment', t('project.assignmentPlaceholder'), t('project.assignment'))),
    h('label', { class: 'proj-field' }, h('strong', {}, t('project.outline')), textArea(p, 'outline', t('project.outlinePlaceholder'), t('project.outline'))),
  );
}

const refParts = (e: BiblioEntry) => e.parts.map((part) => (part.italic ? h('i', {}, part.text) : part.text));

function bibliographyTab(p: Project, c: ProjectCtx) {
  const jobs = c.jobs();
  const pairs = p.sources.flatMap((id) => {
    const job = jobs.find((j) => j.id === id);
    return job ? [{ job, card: c.cards()[id] }] : [];
  });
  const { entries, missing } = bibliography(pairs, p.style, citeLang(p, getLang()), new Date().toISOString().slice(0, 10));
  const style = h(
    'select',
    { 'aria-label': t('project.styleLabel'), onchange: (e: Event) => void save(p.id, { style: (e.target as HTMLSelectElement).value as CitationStyle }) },
    h('option', { value: 'iso690', ...(p.style === 'iso690' ? { selected: true } : {}) }, 'ČSN ISO 690'),
    h('option', { value: 'apa7', ...(p.style === 'apa7' ? { selected: true } : {}) }, 'APA 7'),
  );
  const langSelect = h(
    'select',
    { 'aria-label': t('project.citeLang'), onchange: (e: Event) => void save(p.id, { citeLang: ((e.target as HTMLSelectElement).value || undefined) as Project['citeLang'] }) },
    ...[['', 'app'], ['cs', 'cs'], ['en', 'en']].map(([value, key]) => h('option', { value, ...((p.citeLang ?? '') === value ? { selected: true } : {}) }, t(`project.citeLang.${key}` as MessageKey))),
  );
  const copy = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: !entries.length,
      onclick: () =>
        void writeClipboard(bibliographyText(entries), bibliographyHtml(entries)).then(
          () => toast(t('project.listCopied', { count: entries.length })),
          (e) => toast(cleanError(e), true),
        ),
    },
    icon(ICONS.copy),
    t('project.copyList'),
  );
  const refs = entries.map((e) => {
    const warn = e.gaps.filter((g) => g === 'author' || g === 'year');
    return h(
      'div',
      { class: 'proj-ref' },
      h('p', {}, ...refParts(e)),
      warn.length
        ? h('div', { class: 'proj-gaps' }, h('span', { class: 'chip warn' }, warn.map((g) => t(`project.gap.${g}` as MessageKey)).join(', ')), h('button', { class: 'link', type: 'button', onclick: () => c.open(e.jobId) }, t('project.openCard')))
        : null,
    );
  });
  const lost = missing.map((e) => {
    const job = jobs.find((j) => j.id === e.jobId)!;
    const noCard = e.gaps.includes('card');
    const make = h('button', { class: 'btn', type: 'button' }, t('project.makeCard'));
    make.addEventListener('click', async () => {
      make.disabled = true;
      make.textContent = t('project.makingCard');
      try {
        await window.api.makeCard(job.id);
        c.reload();
      } catch (err) {
        toast(cleanError(err), true);
        make.disabled = false;
        make.textContent = t('project.makeCard');
      }
    });
    return h('div', { class: 'lib-item' }, h('div', { class: 'lib-line' }, h('button', { class: 'job-row', type: 'button', onclick: () => c.open(job.id) }, h('span', {}, h('div', { class: 'job-row-name' }, `${job.name}${job.ext}`))), noCard && job.status === 'done' ? make : h('button', { class: 'btn', type: 'button', onclick: () => c.open(job.id) }, t('project.openCard'))));
  });
  return h(
    'div',
    {},
    h('div', { class: 'proj-actions' }, h('label', { class: 'row gap' }, h('span', { class: 'muted small' }, t('project.styleLabel')), style), h('label', { class: 'row gap' }, h('span', { class: 'muted small' }, t('project.citeLang')), langSelect), copy),
    entries.length ? h('div', { class: 'proj-refs' }, ...refs) : h('p', { class: 'muted' }, t('project.biblioEmpty')),
    lost.length ? h('div', { class: 'proj-missing' }, h('h2', {}, t('project.noCard')), h('div', { class: 'proj-list' }, ...lost)) : null,
  );
}

// ---------- Hlavička a celek ----------

function nameEditor(p: Project) {
  const button = h('button', { class: 'proj-name', type: 'button', title: t('project.rename'), 'aria-label': t('project.rename') }, p.name);
  button.addEventListener('click', () => {
    const input = h('input', { class: 'proj-rename', type: 'text', value: p.name, maxlength: '80', 'aria-label': t('project.rename') });
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.blur();
      if (commit && value && value !== p.name) void save(p.id, { name: value });
      else ctx?.put(p);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    button.replaceWith(input);
    input.focus();
    input.select();
  });
  return button;
}

/** Vykreslí detail projektu do `root`. Probíhající psaní (poznámky, přejmenování) se překreslením nepřeruší. */
export function renderProject(root: HTMLElement, id: string, c: ProjectCtx) {
  ctx = c;
  const p = c.get(id);
  const view = root.firstElementChild as HTMLElement | null;
  const active = document.activeElement;
  if (view?.dataset.project === id && active && view.contains(active) && (active.tagName === 'TEXTAREA' || active.classList.contains('proj-rename'))) return;
  // Rozepsané texty se uloží dřív, než se podle kopie projektu překreslí.
  flushProject();
  if (!p) return root.replaceChildren();

  const study = isStudy(p.kind);
  status = h('span', { class: 'muted small proj-status', role: 'status' });
  const deadline = h('input', { type: 'date', value: p.deadline ?? '', 'aria-label': t('project.deadline') });
  deadline.addEventListener('change', () => void save(p.id, { deadline: deadline.value || undefined }));
  const chatBtn = h('button', { class: 'btn primary', type: 'button', onclick: openChat }, icon(ICONS.chat), t('projectChat.open'));
  const practiceBtn = study && h('button', { class: 'btn', type: 'button', onclick: () => void openPractice(`project:${p.id}`) }, icon(ICONS.sparkle), t('practice.open'));
  const more = actionMenu(() => [
    {
      label: t('project.delete'),
      icon: ICONS.trash,
      danger: true,
      run: () => {
        if (confirm(t('project.confirmDelete', { name: p.name }))) c.remove(p.id);
      },
    },
  ]);
  const head = h(
    'div',
    { class: 'proj-head' },
    h('div', { class: 'proj-title' }, icon(ICONS.book), nameEditor(p), status, chatBtn, practiceBtn, more),
    h('div', { class: 'proj-meta' }, h('span', { class: 'chip accent' }, kindName(p.kind)), h('label', { class: 'row gap' }, h('span', { class: 'muted small' }, t('project.deadline')), deadline)),
  );
  const label = (k: ProjectTab) => t(k === 'bibliography' ? (study ? 'project.tab.bibliography' : 'project.tab.materials') : (`project.tab.${k}` as MessageKey));
  const tabs = h(
    'div',
    { class: 'tabs proj-tabs', role: 'tablist', 'aria-label': t('project.tabs') },
    ...TABS.map((k) =>
      h(
        'button',
        {
          class: `tab${k === tab ? ' active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': String(k === tab),
          onclick: () => {
            flushProject();
            tab = k;
            try {
              localStorage.setItem(TAB_KEY, k);
            } catch {}
            renderProject(root, id, c);
          },
        },
        label(k),
      ),
    ),
  );
  const body = tab === 'sources' ? sourcesTab(p, c) : tab === 'brief' ? briefTab(p) : tab === 'notes' ? h('div', { class: 'proj-brief' }, textArea(p, 'notes', t('project.notesPlaceholder'))) : bibliographyTab(p, c);
  const next = h('div', { class: 'proj-view', 'data-project': id }, head, tabs, h('div', { class: 'proj-body' }, body));
  root.replaceChildren(next);
}
