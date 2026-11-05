import { t } from '../shared/i18n';
import { resolvePath } from '../shared/folders';
import type { LibraryFolder, OrganizePlan } from '../shared/types';
import { cleanError, h, toast } from './dom';

export interface PlanViewOpts {
  /** Název dokumentu. */
  title(jobId: string): string;
  /** Aktuální složky (pro štítek „nová“). */
  folders(): LibraryFolder[];
  /** Návrh se provedl. */
  onDone(): void;
  /** Tlačítko Zrušit (v modálu); bez něj se nezobrazí. */
  onCancel?: () => void;
  /** Návrh už byl proveden dřív (po překreslení chatu). */
  done?: boolean;
}

/** Náhled návrhu roztřídění: úpravy cest, výběr dokumentů, odpovědi na dotazy a potvrzení. */
export function planView(plan: OrganizePlan, opts: PlanViewOpts): HTMLElement {
  const root = h('div', { class: 'plan-view' });
  // Jeden dokument do jedné složky: stačí krátká otázka Ano / Ne.
  const [only] = plan.folders;
  if (plan.folders.length === 1 && only.jobIds.length === 1 && !plan.questions.length) return confirmView(root, only.path, only.jobIds[0], opts);
  const groups = plan.folders.map((f) => ({
    path: h('input', { class: 'plan-path', type: 'text', value: f.path, 'aria-label': t('organize.pathLabel') }),
    docs: f.jobIds.map((id) => ({ id, check: h('input', { type: 'checkbox', checked: true }) })),
  }));
  // Odpověď na dotaz: vybraná cesta, null = nechat zatím.
  const answers = new Map<string, string | null>(plan.questions.map((q) => [q.jobId, null]));

  const newBadge = (input: HTMLInputElement, badge: HTMLElement) => {
    const path = input.value.trim();
    badge.hidden = !path || resolvePath(opts.folders(), path) !== undefined;
  };

  const folderBlocks = plan.folders.map((f, i) => {
    const { path, docs } = groups[i];
    const badge = h('span', { class: 'plan-new' }, t('organize.new'));
    newBadge(path, badge);
    path.addEventListener('input', () => newBadge(path, badge));
    return h(
      'div',
      { class: 'plan-folder' },
      h('div', { class: 'plan-folder-head' }, path, badge),
      ...docs.map((d) => h('label', { class: 'plan-doc' }, d.check, h('span', {}, opts.title(d.id)))),
    );
  });

  const questionBlocks = plan.questions.map((q) => {
    const name = `plan-q-${q.jobId}`;
    const option = (value: string | null, label: string, isNew = false) => {
      const radio = h('input', { type: 'radio', name, ...(value === null ? { checked: true } : {}) });
      radio.addEventListener('change', () => answers.set(q.jobId, value));
      return h('label', { class: 'plan-option' }, radio, h('span', {}, label), isNew && h('span', { class: 'plan-new' }, t('organize.new')));
    };
    return h(
      'div',
      { class: 'plan-question' },
      h('strong', {}, t('library.question', { doc: opts.title(q.jobId) })),
      ...q.options.map((o) => option(o, o, resolvePath(opts.folders(), o) === undefined)),
      option(null, t('organize.keep')),
    );
  });

  const apply = h('button', { class: 'btn primary', type: 'button' }, t('organize.apply'));
  const actions = h('div', { class: 'plan-actions' }, apply, opts.onCancel && h('button', { class: 'btn', type: 'button', onclick: opts.onCancel }, t('organize.cancel')));
  const finish = () => actions.replaceChildren(h('span', { class: 'muted' }, t('organize.done')));

  apply.addEventListener('click', async () => {
    const folders = groups
      .map((g) => ({ path: g.path.value.trim(), jobIds: g.docs.filter((d) => d.check.checked).map((d) => d.id) }))
      .filter((f) => f.path && f.jobIds.length);
    const questions = plan.questions.filter((q) => answers.get(q.jobId) === null);
    for (const q of plan.questions) {
      const path = answers.get(q.jobId);
      if (path) folders.push({ path, jobIds: [q.jobId] });
    }
    apply.disabled = true;
    try {
      await window.api.applyPlan({ folders, questions });
    } catch (e) {
      apply.disabled = false;
      return toast(cleanError(e), true);
    }
    toast(t('organize.finished'));
    finish();
    opts.onDone();
  });

  if (opts.done) finish();
  root.append(...folderBlocks, ...questionBlocks, actions);
  return root;
}

/** „Přesunout {doc} do {path}?“ s Ano / Ne. */
function confirmView(root: HTMLElement, path: string, jobId: string, opts: PlanViewOpts): HTMLElement {
  const isNew = resolvePath(opts.folders(), path) === undefined;
  const actions = h('div', { class: 'plan-actions' });
  const finish = (label: string) => actions.replaceChildren(h('span', { class: 'muted' }, label));
  const yes = h('button', { class: 'btn primary', type: 'button' }, t('organize.yes'));
  const no = h('button', { class: 'btn', type: 'button', onclick: () => (finish(t('organize.kept')), opts.onCancel?.()) }, t('organize.no'));
  yes.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    try {
      await window.api.applyPlan({ folders: [{ path, jobIds: [jobId] }], questions: [] });
    } catch (e) {
      yes.disabled = no.disabled = false;
      return toast(cleanError(e), true);
    }
    finish(t('organize.moved'));
    opts.onDone();
  });
  actions.append(yes, no);
  if (opts.done) finish(t('organize.done'));
  root.append(h('p', { class: 'plan-confirm' }, t('organize.confirmMove', { doc: opts.title(jobId), path }), isNew && h('span', { class: 'plan-new' }, t('organize.new'))), actions);
  return root;
}
