import { t } from '../shared/i18n';
import { isOnline } from '../shared/provider';
import { LIBRARY_CHAT, projectChatKey } from '../shared/folders';
import type { ChatMessage, ChatModel, Job, LibraryRef, LmStatus, Project, Provider, Segment, Settings } from '../shared/types';
import { chatWarningText, cleanError, h, icon, ICONS } from './dom';
import { focusDocs, libraryFolders, selectedFolder, showAll } from './library';
import { planView } from './plan-view';

export interface ChatHost {
  segments(): Segment[];
  cite(segment: Segment): void;
  openSettings(): void;
}

export interface LibraryChatHost {
  /** Název dokumentu pro titulek citace. */
  title(jobId: string): string;
  /** Otevře dokument citace (když už není otevřený) a zvýrazní segment. */
  cite(ref: LibraryRef): Promise<void>;
}

const $ = (id: string) => document.getElementById(id)!;
const SNIPPET = 140;
const textOf = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? s.source;

let host: ChatHost;
let libraryHost: LibraryChatHost;
// Návrhy roztřídění provedené z chatu (podle času zprávy), aby po překreslení zůstaly označené.
const appliedPlans = new Set<number>();
/** Rozsah chatu: jeden dokument, celá knihovna (jobId je pak LIBRARY_CHAT), nebo projekt (jobId je projectChatKey). */
let scope: 'doc' | 'library' | 'project' = 'doc';
let proj: Project | null = null;
/** Dokument se právě otevírá z citace: panel zůstane v rozsahu knihovna. */
let viaCite = false;
/** Panel byl v knihovně otevřený, když se odešlo z view; po návratu se otevře znovu. */
let restore = false;
/** Zaškrtávátko „Jen ve složce“; výchozí zapnuto. */
let onlyFolder = true;
let jobId: string | null = null;
let job: Job | null = null;
let history: ChatMessage[] = [];
let pending: string | null = null;
interface Step {
  text: string;
  tags?: string[];
}
/** Průběh právě běžící odpovědi: kroky, psaný text a úvahy modelu. */
let run: { steps: Step[]; text: string; reasoning: string; started: number } | null = null;
let reasoningOpen = false;
let error = '';
let open = false;
let settings: Settings | null = null;
let localModels: LmStatus['models'] = [];
let remoteModels: LmStatus['models'] = [];
let hasKey = false;
let choice: Provider | null = null;
let closeMenu: (() => void) | null = null;

type Entry = LmStatus['models'][number];

const entryOf = (provider: Provider, key: string): Entry =>
  (provider === 'openrouter' ? remoteModels : localModels).find((m) => m.key === key) ?? { key, name: key, vision: false, sizeBytes: 0 };

/** Model chatu pro poskytovatele: volba z Nastavení, jinak role polish. */
const modelFor = (provider: Provider): ChatModel => {
  const key = provider === 'openrouter' ? (settings!.chatModels?.remote ?? settings!.remoteModels.polish) : (settings!.chatModels?.local ?? settings!.models.polish);
  return { provider, model: key, name: entryOf(provider, key).name };
};

/** Poskytovatel zvolený v menu chatu (jen do konce běhu aplikace), jinak globální z postranního panelu; model určuje Nastavení.
 * Zvolený poskytovatel s modelem; online bez klíče by chat jen hlásil chybu, tak platí model v počítači. */
const current = (): ChatModel => modelFor(activeProvider());

function activeProvider(): Provider {
  if (choice === 'local' || (choice === 'openrouter' && hasKey)) return choice;
  return isOnline(settings ?? {}) && hasKey ? 'openrouter' : 'local';
}

function choose(provider: Provider) {
  choice = provider;
  closeMenu?.();
  renderModel();
  renderMessages();
}

const panel = () => $('chat-panel');
const send = () => ($('chat-send') as HTMLButtonElement);
const input = () => $('chat-input') as HTMLTextAreaElement;

interface Cite {
  title: string;
  click(): void;
}

/** Text odpovědi s citacemi [n] jako klikacími čipy; text modelu jde jen jako text node. */
function answerText(text: string, resolve: (n: number) => Cite | undefined) {
  const box = h('div', { class: 'chat-text' });
  // Markdown z modelu: odrážky „* “/„- “ jako tečky, tučné ** bez hvězdiček.
  const plain = text.replace(/^(\s*)[*-]\s+/gm, '$1• ').replace(/\*\*(.+?)\*\*/g, '$1');
  plain.split(/\[(\d+)\]/).forEach((part, i) => {
    if (i % 2 === 0) return void (part && box.append(part));
    const found = resolve(Number(part));
    if (!found) return void box.append(`[${part}]`);
    box.append(h('button', { class: 'cite-chip', title: found.title, onclick: found.click }, part));
  });
  return box;
}

function stepsList(steps: Step[], active: boolean) {
  return h(
    'ul',
    { class: 'chat-steps' },
    ...steps.map((st, i) =>
      h(
        'li',
        { class: active && i === steps.length - 1 ? 'current' : 'done' },
        active && i === steps.length - 1 ? h('span', { class: 'chat-spin' }) : icon(ICONS.check),
        h('span', {}, st.text),
        !!st.tags?.length && h('span', { class: 'chat-tags' }, ...st.tags.map((tag) => h('span', { class: 'chat-tag' }, tag))),
      ),
    ),
  );
}

/** Sbalený průběh u hotové odpovědi: jeden řádek, po kliknutí kroky. */
function stepsSummary(m: ChatMessage) {
  if (!m.steps?.length) return null;
  const s = String(Math.max(1, Math.round((m.ms ?? 0) / 1000)));
  const label =
    m.docs !== undefined ? t('libraryChat.done', { count: m.docs, s }) : m.whole || m.found === undefined ? t('chat.doneWhole', { s }) : t('chat.doneFound', { n: m.found, s });
  return h('details', { class: 'chat-done' }, h('summary', {}, label), stepsList(m.steps.map((text) => ({ text })), false));
}

/** Rozpracovaná odpověď; po dokončení ji nahradí finální zpráva s citacemi. */
function runEl() {
  if (!run) return null;
  const box = h('div', { class: 'chat-run' }, stepsList(run.steps, !run.text));
  if (run.reasoning) {
    const details = h('details', { class: 'chat-reasoning' }, h('summary', {}, t('chat.reasoning')), h('div', { class: 'chat-text muted' }, run.reasoning));
    details.open = reasoningOpen;
    details.addEventListener('toggle', () => (reasoningOpen = details.open));
    box.append(details);
  }
  if (run.text) box.append(h('div', { class: 'chat-text chat-stream' }, run.text));
  return box;
}

/** Citace dokumentu: čip ukáže úryvek, klik zvýrazní segment v otevřeném dokumentu. */
const segmentCite = (byId: Map<number, Segment>) => (n: number): Cite | undefined => {
  const segment = byId.get(n);
  return segment && { title: `${t('chat.source', { n, page: segment.page ?? '–' })}: ${textOf(segment).slice(0, SNIPPET)}`, click: () => host.cite(segment) };
};

/** Citace knihovny: čip s názvem dokumentu a stranou, klik otevře dokument na místě citace. */
const refCite = (refs: LibraryRef[] = []) => (n: number): Cite | undefined => {
  const ref = refs.find((r) => r.n === n);
  if (!ref) return undefined;
  const name = libraryHost.title(ref.jobId);
  const click = async () => {
    viaCite = true;
    try {
      await libraryHost.cite(ref);
    } finally {
      viaCite = false;
    }
  };
  return { title: ref.page === undefined ? name : t('libraryChat.source', { title: name, page: ref.page }), click };
};

function messageEl(m: ChatMessage, byId: Map<number, Segment>) {
  if (m.role === 'user') return h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-text' }, m.text));
  if (scope === 'project') return h('div', { class: 'chat-msg assistant' }, stepsSummary(m), answerText(m.text, refCite(m.refs)), h('div', { class: 'chat-note' }, m.model ?? ''));
  if (scope === 'library') return h('div', { class: 'chat-msg assistant' }, stepsSummary(m), answerText(m.text, refCite(m.refs)), m.plan && planView(m.plan, { title: libraryHost.title, folders: libraryFolders, done: appliedPlans.has(m.at), onDone: () => appliedPlans.add(m.at) }), h('div', { class: 'chat-note' }, m.model ?? ''));
  return h('div', { class: 'chat-msg assistant' }, stepsSummary(m), answerText(m.text, segmentCite(byId)), h('div', { class: 'chat-note' }, [m.whole ? t('chat.whole') : t('chat.found'), m.model].filter(Boolean).join(' · ')));
}

function renderMessages() {
  const byId = new Map(host.segments().map((s) => [s.id, s]));
  const list = $('chat-messages');
  list.replaceChildren(
    h('div', { class: 'chat-intro' }, h('p', {}, t(scope === 'project' ? 'projectChat.intro' : scope === 'library' ? 'libraryChat.intro' : 'chat.intro')), h('p', { class: 'muted' }, t(settings && current().provider === 'openrouter' ? 'chat.online' : 'chat.private'))),
    ...history.map((m) => messageEl(m, byId)),
  );
  if (pending !== null) list.append(h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-text' }, pending)), runEl() ?? h('div', { class: 'chat-wait muted' }, t('chat.thinking')));
  if (error) list.append(h('div', { class: 'error-box' }, error));
  list.scrollTop = list.scrollHeight;
  const busy = pending !== null;
  send().disabled = busy;
  input().disabled = busy;
  for (const b of panel().querySelectorAll<HTMLButtonElement>('.chat-quick button, #chat-clear, .chat-model')) b.disabled = busy;
}

async function ask(question: string) {
  const id = jobId;
  question = question.trim();
  if (!id || !question || pending !== null) return;
  pending = question;
  run = { steps: [], text: '', reasoning: '', started: Date.now() };
  reasoningOpen = false;
  error = '';
  input().value = '';
  renderMessages();
  try {
    const model = settings ? current() : undefined;
    const folder = onlyFolder ? selectedFolder() : null;
    const answer =
      scope === 'project'
        ? await window.api.askProject(proj!.id, question, model)
        : scope === 'library'
          ? await window.api.askLibrary(question, model, folder?.id, focusDocs())
          : await window.api.askDocument(id, question, model);
    if (jobId !== id) return;
    history.push({ role: 'user', text: question, at: Date.now() }, answer);
  } catch (e) {
    if (jobId !== id) return;
    error = cleanError(e);
    input().value = question;
  }
  pending = null;
  run = null;
  renderMessages();
  input().focus();
}

const chipLabel = (c: ChatModel) => `${t(c.provider === 'openrouter' ? 'chat.modelOnline' : 'chat.modelLocal')} · ${c.name}`;

const warnIcon = () => {
  const el = icon(ICONS.alert);
  el.classList.add('warn-icon');
  return el;
};

const warningOf = (c: ChatModel) => chatWarningText({ ...entryOf(c.provider, c.model), name: c.name ?? c.model });

/** Čip modelu a poznámka pod polem; po změně volby nebo načtení modelů. */
function renderModel() {
  const el = document.getElementById('chat-model');
  if (!el || !settings) return;
  const c = current();
  const online = c.provider === 'openrouter';
  const warning = warningOf(c);
  el.title = warning ? `⚠ ${warning}` : t('chat.modelPick');
  el.replaceChildren(icon(online ? ICONS.globe : ICONS.lock), h('span', { class: 'chat-model-name' }, chipLabel(c)), ...(warning ? [warnIcon()] : []), icon(ICONS.chevron));
  $('chat-privacy').textContent = t(online ? 'chat.noteOnline' : 'chat.noteLocal');
}

function modelMenu(anchor: HTMLElement) {
  const menu = h('div', { class: 'chat-menu', role: 'menu' });
  const selected = activeProvider();
  const item = (provider: Provider, disabled = false) => {
    const c = modelFor(provider);
    const warning = warningOf(c);
    return h(
      'button',
      { class: 'chat-menu-item', role: 'menuitemradio', 'aria-checked': String(provider === selected), title: warning ?? '', disabled, onclick: () => choose(provider) },
      h('span', {}, t(provider === 'openrouter' ? 'chat.menuOnline' : 'chat.menuLocal', { name: c.name ?? c.model })),
      provider === selected ? icon(ICONS.check) : null,
      warning ? warnIcon() : null,
    );
  };
  menu.append(
    item('local'),
    item('openrouter', !hasKey),
    ...(hasKey ? [] : [h('div', { class: 'chat-menu-hint' }, t('chat.modelNoKey'))]),
    h('button', { class: 'chat-menu-item more', onclick: () => (closeMenu?.(), host.openSettings()) }, h('span', {}, t('chat.changeModels'))),
  );
  anchor.append(menu);
  return menu;
}

function toggleMenu(anchor: HTMLElement) {
  if (closeMenu) return closeMenu();
  const menu = modelMenu(anchor);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), closeMenu?.());
  const onDown = (e: MouseEvent) => {
    if (!anchor.contains(e.target as Node)) closeMenu?.();
  };
  closeMenu = () => {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    closeMenu = null;
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
}

/** Zaškrtávátko „Jen ve složce“ jen v knihovně s vybranou složkou; volá se i při změně výběru složky. */
export function renderFolderOpt() {
  const box = document.getElementById('chat-folder');
  if (!box) return;
  const folder = scope === 'library' ? selectedFolder() : null;
  const check = h('input', { type: 'checkbox' }) as HTMLInputElement;
  check.checked = onlyFolder;
  check.addEventListener('change', () => (onlyFolder = check.checked));
  box.hidden = !folder;
  box.replaceChildren(...(folder ? [check, h('span', {}, t('libraryChat.onlyFolder', { name: folder.name }))] : []));
}

const titleText = () => (scope === 'project' ? t('projectChat.title', { name: proj?.name ?? '' }) : t(scope === 'library' ? 'libraryChat.title' : 'chat.tab'));

function buildPanel() {
  closeMenu?.();
  const quick = (label: 'chat.summary' | 'chat.keyPoints', prompt: 'chat.summaryPrompt' | 'chat.keyPointsPrompt') => h('button', { class: 'btn', onclick: () => void ask(t(prompt)) }, t(label));
  const field = h('textarea', { id: 'chat-input', rows: '2', placeholder: t(scope === 'project' ? 'projectChat.placeholder' : scope === 'library' ? 'libraryChat.placeholder' : 'chat.placeholder') });
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void ask(field.value);
  });
  $('chat-inner').replaceChildren(
    h(
      'div',
      { class: 'chat-head' },
      h('strong', { id: 'chat-title' }, titleText()),
      h(
        'button',
        {
          id: 'chat-clear',
          class: 'btn',
          title: t('chat.clear'),
          'aria-label': t('chat.clear'),
          onclick: async () => {
            if (!jobId) return;
            await (scope === 'project' ? window.api.clearProjectChat(proj!.id) : scope === 'library' ? window.api.clearLibraryChat() : window.api.clearChat(jobId));
            history = [];
            error = '';
            renderMessages();
          },
        },
        icon(ICONS.trash),
      ),
    ),
    h('div', { class: 'chat-messages', id: 'chat-messages' }),
    ...(scope === 'doc' ? [h('div', { class: 'chat-quick' }, quick('chat.summary', 'chat.summaryPrompt'), quick('chat.keyPoints', 'chat.keyPointsPrompt'))] : []),
    ...(scope === 'project'
      ? [
          h(
            'div',
            { class: 'chat-quick' },
            ...(['1', '2', '3'] as const).map((n) =>
              h('button', { class: 'btn', onclick: () => (field.value = t(`projectChat.q${n}Prompt`), field.focus()) }, t(`projectChat.q${n}`)),
            ),
          ),
        ]
      : []),
    h('label', { class: 'chat-folder', id: 'chat-folder', hidden: true }),
    h(
      'div',
      { class: 'chat-form' },
      field,
      h(
        'div',
        { class: 'chat-controls' },
        h('button', { id: 'chat-model', class: 'chat-model', title: t('chat.modelPick'), 'aria-label': t('chat.modelPick'), 'aria-haspopup': 'menu', onclick: (e: Event) => toggleMenu((e.currentTarget as HTMLElement).closest('.chat-form') as HTMLElement) }),
        h('span', { id: 'chat-privacy', class: 'chat-privacy muted' }),
        h('button', { id: 'chat-send', class: 'chat-send', title: t('chat.send'), 'aria-label': t('chat.send'), onclick: () => void ask(field.value) }, icon(ICONS.up)),
      ),
    ),
  );
}

// Poslední načtení historie; askLibrary na něj počká, aby odeslaná otázka nezmizela s `history = []`.
let loading: Promise<void> = Promise.resolve();
const load = () => (loading = loadHistory());

async function loadHistory() {
  const id = jobId;
  if (!id || !open) return;
  history = [];
  pending = null;
  run = null;
  error = '';
  try {
    const [messages, s, local, remote] = await Promise.all([
      scope === 'project' ? window.api.projectChat(proj!.id) : scope === 'library' ? window.api.libraryChat() : window.api.jobChat(id),
      window.api.getSettings(),
      window.api.lmStatus('local').catch(() => null),
      window.api.lmStatus('openrouter').catch(() => null),
    ]);
    if (jobId !== id) return;
    history = messages;
    settings = s;
    localModels = local?.models ?? [];
    remoteModels = remote?.models ?? [];
    hasKey = Boolean(remote?.hasKey);
  } catch (e) {
    error = cleanError(e);
  }
  renderMessages();
  renderModel();
}

// Chat se otevírá a zavírá ikonou v horní liště, vidět je všude, kde je k čemu se ptát.
function syncBar() {
  const bar = $('chat-bar');
  bar.hidden = jobId === null;
  bar.classList.toggle('active', open);
  bar.title = t(open ? 'chat.hide' : scope === 'project' ? 'projectChat.show' : scope === 'library' ? 'libraryChat.show' : 'chat.show');
  bar.setAttribute('aria-label', bar.title);
}

function setOpen(value: boolean) {
  open = value;
  panel().hidden = !open;
  syncBar();
  // Levý panel se podle toho automaticky skládá na lištu.
  document.dispatchEvent(new CustomEvent<boolean>('chat-open-changed', { detail: open }));
  if (open) {
    buildPanel();
    renderFolderOpt();
    void load();
  }
}

/** Panel se otevře až na žádost, historie se načte pro aktuální úlohu. */
export function showChat(j: Job) {
  // Dokument otevřený z citace: panel zůstane v rozsahu knihovna.
  if (scope !== 'doc' && viaCite) return;
  if (scope === 'doc' && jobId === j.id) return;
  const fromLibrary = scope !== 'doc';
  scope = 'doc';
  jobId = j.id;
  job = j;
  if (fromLibrary && open) setOpen(false);
  syncBar();
  void load();
}

/** Chat s celou knihovnou mimo detail; panel se otevře až na žádost (nebo znovu, byl-li otevřený). keepProject: v Dokumentech zůstává chat vybraného projektu. */
export function showLibraryChat(keepProject = true) {
  if (!keepProject) proj = null;
  if (scope === 'project' && proj) return enter('project', projectChatKey(proj.id));
  enter('library', LIBRARY_CHAT);
}

/** Otevře chat s knihovnou (Soubory, pohled Vše) a rovnou odešle otázku. */
export async function askLibrary(question: string) {
  showAll();
  // Z chatu projektu zpět na celou knihovnu.
  proj = null;
  enter('library', LIBRARY_CHAT);
  // Otevřený panel načetl historii už v enter(); zavřený ji načte až setOpen.
  if (!open) setOpen(true);
  await loading;
  await ask(question);
}

/** Chat projektu ve view Knihovna; null = výběr už není projekt, panel se vrátí k chatu s knihovnou. Volá se při každém překreslení. */
export function showProjectChat(p: Project | null) {
  if (!p) {
    if (scope !== 'project') return;
    proj = null;
    return enter('library', LIBRARY_CHAT);
  }
  if (scope === 'project' && proj?.id === p.id) {
    proj = p;
    const title = document.getElementById('chat-title');
    if (title) title.textContent = titleText();
    return;
  }
  proj = p;
  enter('project', projectChatKey(p.id));
}

function enter(next: 'library' | 'project', key: string) {
  scope = next;
  jobId = key;
  job = null;
  syncBar();
  if (restore) {
    restore = false;
    return setOpen(true);
  }
  if (open) {
    buildPanel();
    renderFolderOpt();
    void load();
  }
}

/** Změna globálního poskytovatele nebo modelů v Nastavení se hned projeví v chipu i menu chatu. */
export function syncChatSettings(next: Settings) {
  if (!settings) return;
  settings = next;
  renderModel();
  renderMessages();
}

/** Otevře panel chatu (po otevření detailu z knihovny). */
export const openChat = () => setOpen(true);

/** Mimo detail úlohy se panel zavře. */
export function resetChat() {
  if (open) restore = scope !== 'doc';
  jobId = null;
  if (open) setOpen(false);
  syncBar();
}

const WIDTH_KEY = 'chatWidth';
const MIN_WIDTH = 300;
// Tažením užším než tohle se chat zasune do lišty.
const CLOSE_WIDTH = 200;

function setWidth(px: number) {
  panel().style.setProperty('--chat-width', `${Math.round(px)}px`);
}

/** Šířka panelu tažením za levý okraj; pamatuje si ji jen tento počítač. */
function setupResize() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved >= MIN_WIDTH) setWidth(saved);
  } catch {}
  const handle = $('chat-resize');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const right = panel().getBoundingClientRect().right;
    handle.classList.add('dragging');
    let closing = false;
    const move = (ev: MouseEvent) => {
      closing = right - ev.clientX < CLOSE_WIDTH;
      panel().classList.toggle('closing', closing);
      setWidth(Math.min(window.innerWidth / 2, Math.max(MIN_WIDTH, right - ev.clientX)));
    };
    const up = () => {
      handle.classList.remove('dragging');
      panel().classList.remove('closing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (closing) return setOpen(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(panel().getBoundingClientRect().width));
      } catch {}
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

export function setupLibraryChat(chatHost: LibraryChatHost) {
  libraryHost = chatHost;
}

export function setupChat(chatHost: ChatHost) {
  host = chatHost;
  window.api.onChatProgress((p) => {
    if (!run || p.jobId !== jobId) return;
    run.steps.push({ text: p.step, tags: p.tags });
    renderMessages();
  });
  window.api.onChatDelta((d) => {
    if (!run || d.jobId !== jobId) return;
    run.text += d.content ?? '';
    run.reasoning += d.reasoning ?? '';
    renderMessages();
  });
  $('chat-bar').addEventListener('click', () => setOpen(!open));
  setupResize();
}
