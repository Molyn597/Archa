import { t, type MessageKey } from '../shared/i18n';
import { parseSubjects } from '../shared/library-templates';
import type { LibraryKind, Provider, Settings } from '../shared/types';
import { h, icon, ICONS } from './dom';

interface WelcomeContext {
  settings: () => Settings;
  /** Uloží nastavení a po změně poskytovatele překreslí úvodní stránku. */
  setProvider: (p: Provider) => Promise<void>;
  save: () => Promise<void>;
  openSettings: () => void;
}

const STEPS = ['intro', 'libraries', 'where', 'how'] as const;
const KINDS: LibraryKind[] = ['work', 'study', 'personal'];
const TITLES = { intro: 'welcome.1.title', libraries: 'welcome.libraries.title', where: 'welcome.2.title', how: 'welcome.3.title' } as const;

/** Výběr knihoven: jeden obsah pro průvodce i samostatný dialog. `apply` založí knihovny nejvýše jednou. */
function librariesPanel() {
  const picked = new Set<LibraryKind>();
  let keep: LibraryKind | undefined;
  let hasData = false;
  let done = false;
  const checks = new Map<string, HTMLInputElement>();
  const check = (key: string, label: string, onchange: (on: boolean) => void, desc?: MessageKey) => {
    const input = h('input', { type: 'checkbox', onchange: () => onchange(input.checked) });
    checks.set(key, input);
    return h('label', { class: 'check-field welcome-kind' }, input, h('strong', {}, label), desc ? h('span', { class: 'muted small' }, t(desc)) : '');
  };
  const subjects = h('input', { type: 'text', placeholder: t('welcome.libraries.subjectsHint') });
  const subjectsRow = h('label', { class: 'welcome-sub' }, h('span', {}, t('welcome.libraries.subjects')), subjects);
  const keepRow = h('div', { class: 'welcome-sub', role: 'radiogroup' });

  const sync = () => {
    for (const k of KINDS) checks.get(k)!.checked = picked.has(k);
    checks.get('all')!.checked = picked.size === KINDS.length;
    subjectsRow.hidden = !picked.has('study');
    if (!keep || !picked.has(keep)) keep = KINDS.find((k) => picked.has(k));
    keepRow.hidden = !hasData || !picked.size;
    keepRow.replaceChildren(
      h('span', {}, t('welcome.libraries.keep')),
      ...KINDS.filter((k) => picked.has(k)).map((k) => {
        const radio = h('input', { type: 'radio', name: 'library-keep', onchange: () => (keep = k) });
        radio.checked = keep === k;
        return h('label', { class: 'check-field' }, radio, t(`libraryKind.${k}`));
      }),
    );
    for (const el of [...checks.values(), subjects, ...keepRow.querySelectorAll('input')]) el.disabled = done;
  };
  const toggle = (k: LibraryKind, on: boolean) => (on ? picked.add(k) : picked.delete(k), sync());

  const node = h(
    'div',
    { class: 'welcome-libraries' },
    h('p', {}, t('welcome.libraries.text')),
    check('all', t('welcome.libraries.all'), (on) => (KINDS.forEach((k) => (on ? picked.add(k) : picked.delete(k))), sync())),
    ...KINDS.map((k) => check(k, t(`libraryKind.${k}`), (on) => toggle(k, on), `welcome.libraries.${k}.desc` as MessageKey)),
    subjectsRow,
    keepRow,
  );
  void Promise.all([window.api.listJobs(), window.api.listProjects()]).then(([jobs, projects]) => {
    hasData = jobs.length > 0 || projects.length > 0;
    sync();
  });
  sync();

  const finishSetup = async (kinds: LibraryKind[], opts: { subjects?: string[]; keep?: LibraryKind }) => {
    if (done) return;
    done = true;
    sync();
    // Skip nesmí přepsat už proběhlé nastavení (např. z jiného okna).
    if (kinds.length || !(await window.api.libraries()).setupDone) await window.api.setupLibraries(kinds, opts);
    document.dispatchEvent(new CustomEvent('libraries-changed'));
  };
  return {
    node,
    apply: () => {
      const kinds = KINDS.filter((k) => picked.has(k));
      return finishSetup(kinds, kinds.length ? { subjects: parseSubjects(subjects.value), keep: hasData ? keep : undefined } : {});
    },
    skip: () => finishSetup([], {}),
  };
}

/** Samostatný výběr knihoven pro uživatele, kteří uvítání už viděli, ale knihovny ještě nenastavili. */
export function openLibrarySetup() {
  const root = document.getElementById('welcome')!;
  const panel = librariesPanel();
  const close = async (action: () => Promise<void>) => {
    await action();
    root.hidden = true;
    root.replaceChildren();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') void close(panel.skip);
  };
  document.addEventListener('keydown', onKey);
  root.replaceChildren(
    h(
      'div',
      { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('welcome.libraries.title') },
      h('h2', {}, t('welcome.libraries.title')),
      panel.node,
      h(
        'div',
        { class: 'welcome-foot' },
        h('button', { class: 'btn', onclick: () => void close(panel.skip) }, t('welcome.libraries.later')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: () => void close(panel.apply) }, t('welcome.libraries.save')),
      ),
    ),
  );
  root.hidden = false;
}

// Dlaždice s ikonou nebo číslem kroku, nadpisem a krátkým popisem.
const tile = (mark: Node | string, title: MessageKey, text: MessageKey) =>
  h('div', { class: 'welcome-tile' }, h('span', { class: 'welcome-mark' }, mark), h('strong', {}, t(title)), h('span', { class: 'muted small' }, t(text)));

/** Úvodní průvodce o třech krocích; Přeskočit i Začít ho označí jako zobrazený. */
export function openWelcome(ctx: WelcomeContext) {
  const root = document.getElementById('welcome')!;
  let step = 1;
  const panel = librariesPanel();
  let hasKey: boolean | undefined;

  const finish = async () => {
    await panel.skip();
    root.hidden = true;
    root.replaceChildren();
    document.removeEventListener('keydown', onKey);
    const settings = ctx.settings();
    if (!settings.onboarded) {
      settings.onboarded = true;
      await ctx.save();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') void finish();
  };
  document.addEventListener('keydown', onKey);
  void window.api.hasApiKey().then((k) => {
    hasKey = k;
    if (STEPS[step - 1] === 'where') render();
  });

  const next = async () => {
    if (STEPS[step - 1] === 'libraries') await panel.apply();
    step++;
    render();
  };

  const render = () => {
    const name = STEPS[step - 1];
    const body: (Node | string)[] = [
      h('div', { class: 'welcome-step' }, t('welcome.step', { step, total: STEPS.length })),
      h('h2', {}, t(TITLES[name])),
    ];
    if (name === 'intro') {
      body.push(
        h('p', {}, t('welcome.1.text')),
        h(
          'div',
          { class: 'welcome-tiles' },
          tile(icon(ICONS.file), 'welcome.1.layout', 'welcome.1.layoutText'),
          tile(icon(ICONS.list), 'welcome.1.scans', 'welcome.1.scansText'),
          tile(icon(ICONS.balanced), 'welcome.1.choice', 'welcome.1.choiceText'),
        ),
      );
    }
    if (name === 'libraries') body.push(panel.node);
    if (name === 'where') {
      const settings = ctx.settings();
      body.push(
        h('p', {}, t('welcome.2.text')),
        h(
          'div',
          { class: 'provider-switch', role: 'radiogroup' },
          ...(['local', 'openrouter'] as Provider[]).map((p) =>
            h(
              'button',
              {
                class: settings.provider === p ? 'provider active' : 'provider',
                role: 'radio',
                'aria-checked': String(settings.provider === p),
                onclick: async () => {
                  await ctx.setProvider(p);
                  render();
                },
              },
              h('span', { class: 'provider-title' }, t(`home.provider.${p}`)),
              h('span', { class: 'provider-desc' }, t(`home.provider.${p}Desc`)),
            ),
          ),
        ),
      );
      if (settings.provider === 'openrouter' && hasKey === false) {
        body.push(
          h('p', { class: 'muted' }, t('welcome.2.noKey')),
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                await finish();
                ctx.openSettings();
              },
            },
            t('welcome.2.openSettings'),
          ),
        );
      }
    }
    if (name === 'how') {
      body.push(
        h(
          'div',
          { class: 'welcome-tiles' },
          tile('1', 'welcome.3.add', 'welcome.3.addText'),
          tile('2', 'welcome.3.set', 'welcome.3.setText'),
          tile('3', 'welcome.3.go', 'welcome.3.goText'),
        ),
        h('p', { class: 'muted small' }, t('welcome.3.help')),
      );
    }
    body.push(
      h(
        'div',
        { class: 'welcome-foot' },
        h('button', { class: 'btn', onclick: () => void finish() }, t('welcome.skip')),
        h('span', { class: 'spacer' }),
        h('div', { class: 'welcome-dots' }, ...Array.from({ length: STEPS.length }, (_, i) => h('i', { class: i + 1 === step ? 'on' : '' }))),
        step > 1 ? h('button', { class: 'btn', onclick: () => (step--, render()) }, t('welcome.back')) : '',
        step < STEPS.length
          ? h('button', { class: 'btn primary', onclick: () => void next() }, t('welcome.next'))
          : h('button', { class: 'btn primary', onclick: () => void finish() }, t('welcome.start')),
      ),
    );
    root.replaceChildren(h('div', { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('welcome.1.title') }, ...body));
  };

  root.hidden = false;
  render();
}
