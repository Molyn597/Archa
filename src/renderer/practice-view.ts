import { t } from '../shared/i18n';
import { isoDay } from '../shared/invoices';
import { dueFirst, dueItems, sourcesChanged } from '../shared/practice';
import type { PracticeCard, PracticeQuestion, PracticeState } from '../shared/types';
import { cleanError, h, icon, ICONS, toast } from './dom';

type Mode = 'cards' | 'quiz';

interface Session {
  scope: string;
  state?: PracticeState;
  mode: Mode;
  busy: boolean;
  /** Kartičky tohoto kola, pozice, otočená a kolik jich uživatel umí; `all` = prochází všechny, ne jen dnešní. */
  deck: PracticeCard[];
  i: number;
  flip: boolean;
  known: number;
  all: boolean;
  /** Otázky kvízu, pozice, zvolená odpověď, skóre a běžící vysvětlení. */
  quiz: PracticeQuestion[];
  qi: number;
  chosen?: number;
  score: number;
  explaining: boolean;
}

let openJob: (id: string) => void = () => undefined;
let root: HTMLElement | null = null;
let s: Session | null = null;

/** Okno potřebuje otevřít dokument ze zdroje kartičky. */
export const setupPractice = (open: (id: string) => void) => void (openJob = open);

/** Procvičování složky nebo projektu přes celé okno (`scope` = 'folder:<id>' | 'project:<id>'). */
export async function openPractice(scope: string) {
  close();
  s = { scope, mode: 'cards', busy: false, deck: [], i: 0, flip: false, known: 0, all: false, quiz: [], qi: 0, score: 0, explaining: false };
  root = h('div', { class: 'practice', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
  document.body.append(root);
  window.addEventListener('keydown', onKey, true);
  try {
    const state = await window.api.practiceSet(scope);
    if (s?.scope !== scope) return;
    start(state);
  } catch (e) {
    toast(cleanError(e), true);
    close();
  }
}

function close() {
  // Přehled ukazuje počet kartiček k zopakování.
  if (root) document.dispatchEvent(new Event('practice-changed'));
  root?.remove();
  root = null;
  s = null;
  window.removeEventListener('keydown', onKey, true);
}

/** Nové kolo: dnešní kartičky (nebo všechny) a otázky kvízu, ty k zopakování první. */
function start(state: PracticeState, all = false) {
  if (!s) return;
  const today = isoDay();
  const set = state.set;
  const due = set ? dueFirst(set.questions, today) : [];
  Object.assign(s, {
    state,
    deck: set ? (all ? [...set.cards] : dueItems(set, today)) : [],
    all,
    i: 0,
    flip: false,
    known: 0,
    quiz: set ? [...due, ...set.questions.filter((q) => !due.includes(q))] : [],
    qi: 0,
    chosen: undefined,
    score: 0,
  });
  render();
}

function sourceLine(id: string, page?: number) {
  const title = s?.state?.titles[id];
  if (!title) return null;
  return h(
    'button',
    {
      class: 'link pr-src',
      type: 'button',
      onclick: () => {
        close();
        openJob(id);
      },
    },
    page ? t('practice.sourcePage', { title, page }) : title,
  );
}

/** Řádek klávesových zkratek; [x] v textu = klávesa. */
function keys(text: string) {
  return h('div', { class: 'pr-keys' }, ...text.split(/\[([^\]]+)\]/).map((part, i) => (i % 2 ? h('kbd', {}, part) : part)));
}

function bar(left: string, done: number, total: number, right: string) {
  const fill = h('i');
  fill.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
  return h('div', { class: 'pr-bar' }, h('span', {}, left), h('div', { class: 'pr-prog' }, fill), h('span', {}, right));
}

const acts = (...children: (Node | null | false)[]) => h('div', { class: 'pr-acts' }, ...children);

function cardsView(): Node[] {
  const { deck, i, known } = s!;
  if (!deck.length && !s!.all) {
    return [h('div', { class: 'pr-flash' }, h('div', { class: 'q' }, t('practice.doneToday')), h('div', { class: 'a muted' }, t('practice.doneTodayNote'))), acts(h('button', { class: 'btn', type: 'button', onclick: () => start(s!.state!, true) }, t('practice.all')))];
  }
  if (i >= deck.length) {
    return [h('div', { class: 'pr-flash' }, h('div', { class: 'q' }, t('practice.finished')), h('div', { class: 'a' }, t('practice.cardsEnd', { known, total: deck.length }))), acts(h('button', { class: 'btn', type: 'button', onclick: () => start(s!.state!, s!.all) }, t('practice.again')))];
  }
  const c = deck[i];
  return [
    bar(t('practice.due', { count: deck.length - i }), i, deck.length, t('practice.known', { count: known })),
    h('div', { class: 'pr-flash' }, h('div', { class: 'q' }, c.front), s!.flip && h('div', { class: 'a' }, c.back), s!.flip && sourceLine(c.source, c.page)),
    s!.flip
      ? acts(h('button', { class: 'btn', type: 'button', onclick: () => rate(false) }, t('practice.notYet')), h('button', { class: 'btn primary', type: 'button', onclick: () => rate(true) }, icon(ICONS.check), t('practice.know')))
      : acts(h('button', { class: 'btn primary', type: 'button', onclick: flip }, t('practice.show'))),
  ];
}

function quizView(): Node[] {
  const { quiz, qi, score, chosen } = s!;
  if (qi >= quiz.length) {
    return [
      h('div', { class: 'pr-flash' }, h('div', { class: 'q' }, t('practice.quizEnd', { score, total: quiz.length })), h('div', { class: 'a' }, t(score === quiz.length ? 'practice.quizAll' : 'practice.quizSome'))),
      acts(h('button', { class: 'btn', type: 'button', onclick: () => start(s!.state!, s!.all) }, t('practice.again'))),
    ];
  }
  const q = quiz[qi];
  const answered = chosen !== undefined;
  const options = q.options.map((o, j) =>
    h('button', { class: `opt-card${answered ? (j === q.answer ? ' good' : j === chosen ? ' bad' : '') : ''}`, type: 'button', 'aria-disabled': String(answered), onclick: () => choose(j) }, h('span', {}, o)),
  );
  const out: Node[] = [bar(t('practice.question', { n: qi + 1, total: quiz.length }), qi, quiz.length, t('practice.score', { count: score })), h('div', { class: 'pr-question' }, q.question), h('div', { class: 'pr-options' }, ...options)];
  if (!answered) return out;
  const explained = q.explain && (q.explainFor ?? q.answer) === chosen;
  const why = explained
    ? h('div', { class: 'pr-explain' }, icon(ICONS.sparkle), h('div', {}, q.explain, ' ', sourceLine(q.source, q.page)))
    : h('div', {}, h('button', { class: 'btn sm', type: 'button', disabled: s!.explaining, onclick: () => void explain(q) }, s!.explaining ? h('span', { class: 'chat-spin' }) : icon(ICONS.sparkle), t(s!.explaining ? 'practice.explaining' : 'practice.explain')));
  out.push(
    h('p', { class: 'pr-verdict' }, chosen === q.answer ? t('practice.correct') : t('practice.correctIs', { answer: q.options[q.answer] }), ' ', !explained && sourceLine(q.source, q.page)),
    why,
    acts(h('button', { class: 'btn primary', type: 'button', onclick: next }, t(qi + 1 === quiz.length ? 'practice.result' : 'practice.next'))),
  );
  return out;
}

/** Bez sady: nabídka vytvořit ji (AI jen na klik), bez zdrojů prázdný stav. */
function buildView(state: PracticeState): Node[] {
  if (!state.sources.length) return [h('div', { class: 'empty' }, h('p', {}, t('practice.empty')), h('p', { class: 'muted small' }, t('practice.emptyNote')))];
  const count = state.sources.length;
  const label = state.total > count ? t('practice.buildNewest', { count }) : t('practice.build', { count });
  return [
    h(
      'div',
      { class: 'pr-start' },
      h('button', { class: 'btn primary', type: 'button', disabled: s!.busy, onclick: () => void build() }, s!.busy ? h('span', { class: 'chat-spin' }) : icon(ICONS.sparkle), s!.busy ? t('practice.building') : label),
      h('p', { class: 'muted small' }, t('practice.buildNote')),
    ),
  ];
}

function render() {
  if (!root || !s) return;
  const state = s.state;
  const set = state?.set;
  const seg = (m: Mode, key: 'practice.cards' | 'practice.quiz') =>
    h('button', { class: `segment${s!.mode === m ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(s!.mode === m), onclick: () => ((s!.mode = m), render()) }, t(key));
  const head = h(
    'div',
    { class: 'pr-head' },
    h('h2', {}, t('practice.title', { name: state?.title ?? '' })),
    set && h('div', { class: 'segmented', role: 'tablist' }, seg('cards', 'practice.cards'), seg('quiz', 'practice.quiz')),
  );
  const body: Node[] = !state ? [] : !set ? buildView(state) : [h('p', { class: 'muted pr-intro' }, t('practice.intro', { cards: t('practice.cardCount', { count: set.cards.length }), questions: t('practice.questionCount', { count: set.questions.length }) })), ...(s.mode === 'cards' ? cardsView() : quizView())];
  const foot =
    set &&
    h(
      'div',
      { class: 'pr-foot' },
      sourcesChanged(set, state.sources) && h('span', { class: 'chip warn' }, t('practice.changed')),
      h('button', { class: 'btn sm', type: 'button', disabled: s.busy, onclick: () => confirm(t('practice.rebuildConfirm')) && void build() }, s.busy ? h('span', { class: 'chat-spin' }) : icon(ICONS.retry), t(s.busy ? 'practice.building' : 'practice.rebuild')),
    );
  root.replaceChildren(
    h('button', { class: 'icon-btn pr-close', type: 'button', title: t('practice.close'), 'aria-label': t('practice.close'), onclick: close }, icon(ICONS.x)),
    h('div', { class: 'pr-in' }, head, ...body, foot || null, set && keys(t(s.mode === 'cards' ? 'practice.keysCards' : 'practice.keysQuiz'))),
  );
  // Fokus na okně, ne na tlačítku: mezerník a Enter pak neklikají podruhé.
  root.focus();
}

async function build() {
  if (!s || s.busy) return;
  const scope = s.scope;
  s.busy = true;
  render();
  try {
    const state = await window.api.buildPractice(scope);
    if (s?.scope !== scope) return;
    s.busy = false;
    start(state);
  } catch (e) {
    toast(cleanError(e), true);
    if (s?.scope !== scope) return;
    s.busy = false;
    render();
  }
}

/** Zapíše hodnocení na pozadí; uložená sada nahradí kopii v okně (pořadí kola se nemění). */
function save(id: string, known: boolean) {
  const scope = s!.scope;
  window.api
    .gradePractice(scope, id, known)
    .then((set) => {
      if (s?.scope === scope && s.state) s.state.set = set;
    })
    .catch((e) => toast(cleanError(e), true));
}

function flip() {
  if (!s || s.flip || s.i >= s.deck.length) return;
  s.flip = true;
  render();
}

function rate(known: boolean) {
  if (!s || !s.flip) return;
  save(s.deck[s.i].id, known);
  if (known) s.known++;
  s.i++;
  s.flip = false;
  render();
}

function choose(j: number) {
  if (!s || s.chosen !== undefined) return;
  const q = s.quiz[s.qi];
  if (!q || j >= q.options.length) return;
  s.chosen = j;
  if (j === q.answer) s.score++;
  save(q.id, j === q.answer);
  render();
}

function next() {
  if (!s || s.chosen === undefined) return;
  s.qi++;
  s.chosen = undefined;
  render();
}

async function explain(q: PracticeQuestion) {
  if (!s || s.explaining || s.chosen === undefined) return;
  const scope = s.scope;
  s.explaining = true;
  render();
  try {
    const chosen = s.chosen;
    Object.assign(q, { explain: await window.api.explainQuestion(scope, q.id, chosen), explainFor: chosen });
    const saved = s?.state?.set?.questions.find((x) => x.id === q.id);
    if (saved) Object.assign(saved, { explain: q.explain, explainFor: chosen });
  } catch (e) {
    toast(cleanError(e), true);
  }
  if (s?.scope !== scope) return;
  s.explaining = false;
  render();
}

function onKey(e: KeyboardEvent) {
  if (!s || !root) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.key === 'Escape') return handled(), close();
  if (!s.state?.set || s.busy) return;
  if (s.mode === 'cards') {
    if (e.key === ' ') return handled(), flip();
    if ((e.key === '1' || e.key === '2') && s.flip) return handled(), rate(e.key === '2');
  } else {
    if (/^[1-4]$/.test(e.key) && s.chosen === undefined) return handled(), choose(Number(e.key) - 1);
    if (e.key === 'Enter' && s.chosen !== undefined) return handled(), next();
  }
}
