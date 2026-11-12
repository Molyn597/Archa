import { CHARS_PER_PAGE, estimateCost } from '../shared/cost';
import { formatUsd } from '../shared/estimate';
import { locale, t, type MessageKey, type UiLangSetting } from '../shared/i18n';
import { activeRates, FAST_REMOTE_MODEL, isFreeModel, RECOMMENDED_REMOTE_MODEL } from '../shared/provider';
import { catalogRows, chatModelWarning, formatContext, isFree, sharedModel, visionWarnings } from '../shared/catalog-view';
import { applyTemplate, DEFAULT_NAME_TEMPLATE } from '../shared/name-template';
import type { CitationStyle, Currency, DocumentCard, LmStatus, ModelPrice, Models, Provider, Settings, Theme } from '../shared/types';
import { chatWarningText, duration, h, icon, ICONS, rememberOpen, toast } from './dom';
import { languageName, LANGUAGES } from '../shared/languages';
import { currentKind } from './library-switch';
import { changePasswordModal, refreshVault, vault } from './vault';

const $ = (id: string) => document.getElementById(id)!;

// Po otevření Nastavení se přesune na část Knihovna (odkaz „Nastav svou firmu“).
let wantLibrary = false;
export const scrollToLibrarySettings = () => (wantLibrary = true);

// ---------- Nastavení ----------

const ROLES: { key: keyof Models; title: MessageKey; hint: MessageKey; vision?: boolean }[] = [
  { key: 'polish', title: 'settings.role.polish', hint: 'settings.role.polishHint' },
  { key: 'ocr', title: 'settings.role.ocr', hint: 'settings.role.ocrHint', vision: true },
  { key: 'translate', title: 'settings.role.translate', hint: 'settings.role.translateHint' },
];

type Task = keyof Models | 'chat';

// Úlohy v pořadí, jak se ukazují v Nastavení; chat nemá vlastní roli v `Models`, jeho model je v `chatModels`.
const TASKS: { key: Task; title: MessageKey; hint: MessageKey; vision?: boolean }[] = [
  { key: 'chat', title: 'settings.role.chat', hint: 'settings.role.chatHint' },
  { key: 'polish', title: 'settings.role.polish', hint: 'settings.role.polishHint', vision: true },
  { key: 'ocr', title: 'settings.role.ocr', hint: 'settings.role.ocrHint', vision: true },
  { key: 'translate', title: 'settings.role.translate', hint: 'settings.role.translateHint' },
];

// Poskytovatel, jehož modely se v Nastavení právě upravují (nemění aktivního poskytovatele).
let editedTab: Provider | null = null;

/** Předvolí záložku poskytovatele v sekci Modely (např. odkaz „Změnit modely“ ze stavu v panelu). */
export function setSettingsTab(provider: Provider) {
  editedTab = provider;
  openAdvanced = true;
}

// Příští vykreslení Nastavení otevře Pokročilé (odkaz „Změnit modely“).
let openAdvanced = false;

const gb = (bytes: number) => (bytes ? ` · ${(bytes / 1e9).toFixed(1)} GB` : '');

function toggle(label: string, hint: string, checked: boolean, onChange: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, h('span', {}, h('div', {}, label), h('div', { class: 'muted small' }, hint)), input);
}

export async function renderSettings(onSaved: (s: Settings) => void) {
  const [settings, lm, remote] = await Promise.all([window.api.getSettings(), window.api.lmStatus('local'), window.api.lmStatus('openrouter'), refreshVault()]).then((r) => r.slice(0, 3) as [Settings, LmStatus, LmStatus]);
  const save = async () => {
    await window.api.saveSettings(settings);
    onSaved(settings);
    toast(t('settings.saved'));
  };

  const url = h('input', { type: 'url' });
  url.value = settings.apiUrl;
  url.addEventListener('change', () => {
    settings.apiUrl = url.value.replace(/\/+$/, '') || 'http://localhost:1234';
    void save();
  });

  const rerender = () => renderSettings(onSaved);
  const modelGroup = modelsGroup(settings, lm, remote, url, save, rerender);

  const theme = h('select');
  for (const value of ['system', 'light', 'dark'] as Theme[]) {
    theme.append(h('option', { value, selected: settings.theme === value }, t(`settings.theme.${value}`)));
  }
  theme.addEventListener('change', () => {
    settings.theme = theme.value as Theme;
    void save();
  });

  // Názvy jazyků vždy ve vlastním jazyce, aby šel najít i po omylem přepnutém jazyce.
  const uiLang = h('select');
  for (const [value, label] of [
    ['system', t('settings.uiLang.system')],
    ['cs', 'Čeština'],
    ['en', 'English'],
  ] as [UiLangSetting, string][]) {
    uiLang.append(h('option', { value, selected: settings.uiLang === value }, label));
  }
  uiLang.addEventListener('change', async () => {
    settings.uiLang = uiLang.value as UiLangSetting;
    await window.api.saveSettings(settings);
    location.reload();
  });

  const r = activeRates(settings);

  // Výchozí cílový jazyk překladu (stejná hodnota jako „Do jazyka“ na stránce Přeložit).
  const targetLang = h('select');
  for (const l of LANGUAGES) targetLang.append(h('option', { value: l.code, selected: settings.targetLang === l.code }, languageName(l.code)));
  targetLang.addEventListener('change', () => {
    settings.targetLang = targetLang.value;
    void save();
  });

  const advanced = h(
    'details',
    { class: 'advanced' },
    h('summary', {}, t('settings.app')),
    h(
      'div',
      { class: 'advanced-body stack' },
      modelGroup,
      currencySelect(settings, save, rerender),
      toggle(t('settings.notify'), t('settings.notifyHint'), settings.notify, (v) => {
        settings.notify = v;
        void save();
      }),
      toggle(t('settings.autoCard'), t('settings.autoCardHint'), settings.autoCard, (v) => {
        settings.autoCard = v;
        void save();
      }),
      toggle(t('settings.layoutPdf'), t('settings.layoutPdfHint'), settings.layoutPdf, (v) => {
        settings.layoutPdf = v;
        void save();
      }),
      toggle(t('settings.unload'), t('settings.unloadHint'), settings.unloadWhenIdle, (v) => {
        settings.unloadWhenIdle = v;
        void save();
      }),
      citationRow(settings, save),
      h(
        'div',
        { class: 'toggle' },
        h('span', {}, h('div', {}, t('settings.rates')), h('div', { class: 'muted small' }, t('settings.ratesText', { ocr: duration(r.ocrPerPage), translate: duration(r.translatePerKChar), fix: duration(r.fixPerSegment) }))),
      ),
    ),
  );
  rememberOpen(advanced, 'settingsAdvancedOpen', openAdvanced);
  openAdvanced = false;

  // Pořadí: AI, Jazyk překladu, Vzhled, Zamčené složky, Pokročilé (sbalené).
  $('settings').replaceChildren(
    aiGroup(settings, lm, remote, save, rerender),
    h('section', { class: 'setting-group' }, h('h2', {}, t('settings.targetLang')), h('label', { class: 'field' }, targetLang, h('span', { class: 'muted small' }, t('settings.targetLangHint')))),
    h(
      'section',
      { class: 'setting-group' },
      h('h2', {}, t('settings.section.look')),
      h('label', { class: 'field' }, h('span', {}, 'Jazyk aplikace / App language'), uiLang),
      h('label', { class: 'field' }, h('span', {}, t('settings.theme')), theme),
    ),
    libraryGroup(settings, save, rerender),
    vaultGroup(),
    h('section', { class: 'setting-group' }, advanced),
  );
  if (wantLibrary) $('settings-library').scrollIntoView();
  wantLibrary = false;
}

/** Karta AI: kde AI běží, jestli je připravená, API klíč online a souhrn vybraných modelů. Výběr modelů je v Pokročilém. */
function aiGroup(settings: Settings, lm: LmStatus, remote: LmStatus, save: () => Promise<void>, rerender: () => Promise<void>) {
  const online = settings.provider === 'openrouter';
  const status = online ? remote : lm;
  const missing = status.missing.map((role) => status.models.find((m) => m.key === (online ? settings.remoteModels : settings.models)[role])?.name ?? (online ? settings.remoteModels : settings.models)[role]);
  const ready = online ? Boolean(remote.hasKey) && !missing.length : lm.cli && !missing.length;
  const stateText = online
    ? remote.hasKey
      ? t('settings.remote.keyOk')
      : t('settings.remote.keyMissing')
    : !lm.cli
      ? t('lm.notFound')
      : missing.length
        ? t('lm.missing', { name: [...new Set(missing)].join(', ') })
        : t('lm.ready');

  const segments = (['local', 'openrouter'] as Provider[]).map((p) =>
    h(
      'button',
      {
        class: settings.provider === p ? 'segment active' : 'segment',
        type: 'button',
        role: 'radio',
        'aria-checked': String(settings.provider === p),
        onclick: async () => {
          if (settings.provider === p) return;
          settings.provider = p;
          await save();
          await rerender();
        },
      },
      t(`home.provider.${p}`),
    ),
  );

  const card = h(
    'section',
    { class: 'setting-group' },
    h('h2', {}, t('settings.ai')),
    h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('home.provider') }, ...segments),
    h('p', { class: 'muted small' }, t(`home.provider.${settings.provider}Desc`)),
    h('p', { class: ready ? 'ok-box' : 'warn-box' }, stateText),
    online ? keyBlock(remote, rerender) : '',
    online ? remoteSummary(settings, remote) : localSummary(settings, lm),
    h('p', { class: 'muted small' }, t('settings.ai.advancedHint')),
  );
  return card;
}

/** Zamčené složky: stav hesla trezoru a jeho změna. */
/** Ukázková karta pro náhled šablony názvu. */
const SAMPLE_CARD: DocumentCard = {
  summary: '',
  type: 'invoice',
  keywords: [],
  biblio: { authors: [], title: '' },
  lang: 'cs',
  createdAt: 0,
  facts: { issued: '2026-03-04', supplier: 'ACME s.r.o.', number: '2026/015' },
};

/** Nastavení knihovny: sledovaná složka na disku a šablona názvů dokumentů. */
function libraryGroup(settings: Settings, save: () => Promise<void>, rerender: () => Promise<void>) {
  const folder = settings.watchFolder;
  const pick = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        const picked = await window.api.pickDirectory();
        if (!picked) return;
        settings.watchFolder = picked;
        settings.watchOn = true;
        await save();
        await rerender();
      },
    },
    t('settings.watchPick'),
  );

  const template = h('input', { type: 'text', maxlength: '120', spellcheck: false });
  template.value = settings.nameTemplate;
  const preview = h('span', { class: 'muted small' });
  const showPreview = () => (preview.textContent = t('settings.nameTemplatePreview', { name: applyTemplate(SAMPLE_CARD, template.value) || '—' }));
  showPreview();
  template.addEventListener('input', showPreview);
  template.addEventListener('change', () => {
    settings.nameTemplate = template.value.trim() || DEFAULT_NAME_TEMPLATE;
    void save();
  });

  // Moje firma: faktury knihovny se podle ní dělí na příjmy a výdaje (Studium a Osobní ji nepotřebují).
  const company = settings.ownCompany ?? { name: '', id: '', vat: '' };
  const companyField = (key: keyof typeof company, label: MessageKey, maxlength: string) => {
    const input = h('input', { type: 'text', maxlength, spellcheck: false });
    input.value = company[key];
    input.addEventListener('change', () => {
      company[key] = input.value.trim();
      settings.ownCompany = company;
      void save();
    });
    return h('label', { class: 'field' }, h('span', {}, t(label)), input);
  };
  const kind = currentKind();

  return h(
    'section',
    { class: 'setting-group', id: 'settings-library' },
    h('h2', {}, t('settings.library')),
    (kind === 'work' || kind === 'general') &&
      h(
        'div',
        { class: 'company-fields' },
        h('span', {}, t('settings.company')),
        h('span', { class: 'muted small' }, t('settings.companyHint')),
        h('div', { class: 'company-row' }, companyField('name', 'settings.companyName', '120'), companyField('id', 'settings.companyId', '20'), companyField('vat', 'settings.companyVat', '20')),
      ),
    h('div', { class: 'field' }, h('span', {}, t('settings.watch')), h('div', { class: 'watch-row' }, h('span', { class: 'watch-path' }, folder ?? t('settings.watchNone')), pick), h('span', { class: 'muted small' }, t('settings.watchHint'))),
    folder &&
      toggle(t('settings.watchOn'), t('settings.watchOnHint'), Boolean(settings.watchOn), (v) => {
        settings.watchOn = v;
        void save();
      }),
    h('label', { class: 'field' }, h('span', {}, t('settings.nameTemplate')), template, h('span', { class: 'muted small' }, t('settings.nameTemplateHint')), preview),
    toggle(t('settings.renameByTemplate'), t('settings.renameByTemplateHint'), Boolean(settings.renameByTemplate), (v) => {
      settings.renameByTemplate = v;
      void save();
    }),
  );
}

function vaultGroup() {
  return h(
    'section',
    { class: 'setting-group' },
    h('h2', {}, t('vault.settingsTitle')),
    h('p', { class: vault.exists ? 'ok-box' : 'muted small' }, t(vault.exists ? 'vault.statusSet' : 'vault.statusNone')),
    vault.exists && h('div', { class: 'row gap' }, h('button', { class: 'btn', type: 'button', onclick: () => changePasswordModal(() => void refreshVault()) }, t('vault.change'))),
    h('p', { class: 'muted small' }, t('vault.autoLock')),
  );
}

/** Výchozí citační styl: pro nové projekty a jejich seznam literatury. */
function citationRow(settings: Settings, save: () => Promise<void>) {
  const style = h('select');
  for (const [value, label] of [
    ['iso690', 'ČSN ISO 690'],
    ['apa7', 'APA 7'],
  ] as [CitationStyle, string][]) {
    style.append(h('option', { value, selected: settings.citation.style === value }, label));
  }
  style.addEventListener('change', () => {
    settings.citation.style = style.value as CitationStyle;
    void save();
  });
  return h('label', { class: 'field' }, h('span', {}, t('settings.citationStyle')), style, h('span', { class: 'muted small' }, t('settings.citationStyleHint')));
}

function selectedCard(label: string, body: (Node | string)[], chips: Node[] = []) {
  return h(
    'div',
    { class: 'selected-model' },
    h('div', { class: 'engine-label' }, label),
    ...body,
    chips.length ? h('div', { class: 'chips' }, ...chips) : '',
  );
}

function localSummary(settings: Settings, lm: LmStatus) {
  const name = (key: string) => lm.models.find((m) => m.key === key)?.name ?? key;
  return selectedCard(
    t('settings.local.selected'),
    [
      // Chat jako první: s ním uživatel pracuje nejčastěji; bez volby se použije model oprav.
      h('div', { class: 'selected-role' }, h('span', { class: 'selected-role-name' }, t('settings.role.chat')), h('span', { class: 'selected-model-name' }, name(settings.chatModels?.local || settings.models.polish))),
      ...ROLES.map((role) => h('div', { class: 'selected-role' }, h('span', { class: 'selected-role-name' }, t(role.title)), h('span', { class: 'selected-model-name' }, name(settings.models[role.key])))),
    ],
  );
}

function remoteSummary(settings: Settings, lm: LmStatus) {
  const used = sharedModel(settings.remoteModels);
  const ids = [...new Set(ROLES.map((r) => settings.remoteModels[r.key]))];
  const found = ids.map((id) => lm.models.find((m) => m.key === id));
  const names = ids.map((id, i) => found[i]?.name ?? id).join(' + ');
  const chip = (text: string, cls = '') => h('span', { class: `chip ${cls}` }, text);
  const m = used ? found[0] : undefined;
  const chips: Node[] = [];
  if (found.length && found.every(Boolean)) {
    chips.push(found.every((f) => f!.vision) ? chip(t('settings.remote.vision')) : chip(t('settings.remote.noVisionTag'), 'warn'));
  }
  if (m?.price) chips.push(chip(isFree(m) ? t('settings.remote.free') : t('settings.remote.perM', { input: usd(m.price.input), output: usd(m.price.output) })));
  chips.push(
    lm.hasKey
      ? h('span', { class: 'chip ok' }, icon(ICONS.check), t('settings.remote.keyOk'))
      : h('span', { class: 'chip warn' }, icon(ICONS.alert), t('settings.remote.keyMissing')),
  );
  return selectedCard(t('settings.remote.selected'), [h('div', { class: 'selected-model-name big' }, names)], chips);
}

const price = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 3 });

function currencySelect(settings: Settings, save: () => Promise<void>, rerender: () => Promise<void>) {
  const select = h('select');
  for (const value of ['both', 'czk', 'usd'] as Currency[]) {
    select.append(h('option', { value, selected: settings.currency === value }, t(`settings.currency.${value}`)));
  }
  select.addEventListener('change', async () => {
    settings.currency = select.value as Currency;
    await save();
    await rerender();
  });
  return h('label', { class: 'field' }, h('span', {}, t('settings.currency')), select);
}

type CatalogModel = LmStatus['models'][number];

/** Upozornění k modelu zvolenému pro úlohu: chybí obraz, model nesedí na překlad nebo na chat. */
function taskNotes(task: Task, key: string, catalog: CatalogModel[], models: Models) {
  const entry = catalog.find((m) => m.key === key);
  if (!entry) return [];
  const notes: string[] = [];
  if ((task === 'ocr' || task === 'polish') && visionWarnings(models, catalog).some((w) => w.role === task)) notes.push(t('settings.remote.noVision', { model: entry.name }));
  const warning = chatModelWarning(entry);
  if (task === 'translate' && (warning === 'ocr' || warning === 'embedding')) notes.push(t(warning === 'ocr' ? 'settings.warn.translateOcr' : 'settings.warn.translateEmbedding'));
  if (task === 'chat') {
    const text = chatWarningText(entry);
    if (text) notes.push(text);
  }
  return notes.map((n) => h('p', { class: 'warn-box' }, n));
}

function taskRow(task: (typeof TASKS)[number], ...body: (Node | string)[]) {
  return h('div', { class: 'field task-row' }, h('span', { class: 'task-title' }, t(task.title)), h('span', { class: 'muted small' }, t(task.hint)), ...body);
}

/** Výběr modelu v počítači pro jednu úlohu; chat má navíc volbu „automaticky“ (= model oprav). Vrací řádek a funkci na obnovení po změně jiné úlohy. */
function localTask(task: (typeof TASKS)[number], settings: Settings, lm: LmStatus, save: () => Promise<void>) {
  const chat = (settings.chatModels ??= {});
  const isChat = task.key === 'chat';
  const select = h('select');
  const notes = h('div', { class: 'stack' });
  const effective = () => (isChat ? (chat.local ?? settings.models.polish) : settings.models[task.key as keyof Models]);
  const nameOf = (key: string) => lm.models.find((m) => m.key === key)?.name ?? key;
  const fill = () => {
    const chosen = isChat ? chat.local : settings.models[task.key as keyof Models];
    const options = lm.models.filter((m) => !task.vision || task.key === 'polish' || m.vision);
    select.replaceChildren();
    if (isChat) select.append(h('option', { value: '', selected: !chosen }, t('settings.chat.auto', { name: nameOf(settings.models.polish) })));
    if (chosen && !options.some((m) => m.key === chosen)) select.append(h('option', { value: chosen, selected: true }, t('settings.modelMissing', { model: chosen })));
    for (const m of options) select.append(h('option', { value: m.key, selected: m.key === chosen }, `${isChat && chatModelWarning(m) ? '⚠ ' : ''}${m.name}${gb(m.sizeBytes)}`));
    notes.replaceChildren(...taskNotes(task.key, effective(), lm.models, settings.models));
  };
  select.addEventListener('change', () => {
    if (isChat) chat.local = select.value || undefined;
    else settings.models[task.key as keyof Models] = select.value;
    void save();
  });
  fill();
  return { row: taskRow(task, select, notes), fill };
}

/** Online výběr: tlačítko s aktuálním modelem, které rozbalí hledání v katalogu OpenRouteru. */
function remoteTask(task: (typeof TASKS)[number], settings: Settings, remote: LmStatus, save: () => Promise<void>, rerender: () => Promise<void>) {
  const chat = (settings.chatModels ??= {});
  const isChat = task.key === 'chat';
  const auto = isChat && !chat.remote;
  const key = isChat ? (chat.remote ?? settings.remoteModels.polish) : settings.remoteModels[task.key as keyof Models];
  const nameOf = (id: string) => remote.models.find((m) => m.key === id)?.name ?? id;
  const prices = Object.fromEntries(remote.models.map((m) => [m.key, m.price]));
  const apply = (change: () => void) => {
    change();
    void save().then(rerender);
  };
  const use = (id: string) =>
    apply(() => {
      if (isChat) chat.remote = id;
      else settings.remoteModels[task.key as keyof Models] = id;
    });

  const label = auto ? t('settings.chat.auto', { name: nameOf(key) }) : nameOf(key);
  const pick = h('button', { class: 'model-pick', type: 'button', 'aria-expanded': 'false', title: key }, h('span', { class: 'model-pick-name' }, label), h('span', { class: 'model-pick-note' }, key), icon(ICONS.chevron));
  const body = h('div', { class: 'task-picker stack' });
  body.hidden = true;
  const filter = h('input', { type: 'search', placeholder: t('settings.remote.filter') });
  const visionOnly = h('input', { type: 'checkbox' });
  visionOnly.checked = Boolean(task.vision);
  const list = h('div', { class: 'model-scroll' });
  const more = h('p', { class: 'muted small' });
  const fill = () => {
    const { rows, total } = catalogRows(remote.models, { text: filter.value, visionOnly: Boolean(task.vision) && visionOnly.checked, keep: [key] });
    list.replaceChildren(modelList(rows, auto ? undefined : key, use, (m) => sampleCost(m, settings, prices)));
    more.textContent = total > rows.length ? t('settings.remote.shown', { shown: rows.length, total }) : rows.length ? '' : t('settings.remote.noMatch');
  };
  filter.addEventListener('input', fill);
  visionOnly.addEventListener('change', fill);
  body.append(
    h('div', { class: 'row gap' }, h('div', { class: 'grow' }, filter), task.vision ? h('label', { class: 'check' }, visionOnly, t('settings.remote.visionOnly')) : ''),
    ...(isChat && chat.remote ? [h('button', { class: 'btn', onclick: () => apply(() => (chat.remote = undefined)) }, t('settings.chat.auto', { name: nameOf(settings.remoteModels.polish) }))] : []),
    list,
    more,
  );
  let filled = false;
  pick.addEventListener('click', () => {
    body.hidden = !body.hidden;
    pick.setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) {
      if (!filled) fill();
      filled = true;
      filter.focus();
    }
  });
  // Stejný model pro překlad, OCR i opravy jedním klikem.
  const all = !isChat && sharedModel(settings.remoteModels) === undefined
    ? h('button', { class: 'btn', type: 'button', onclick: () => apply(() => (settings.remoteModels = { ocr: key, translate: key, polish: key })) }, t('settings.models.useAll'))
    : '';
  return taskRow(task, remote.models.length ? pick : h('span', { class: 'selected-model-name' }, key), remote.models.length ? body : '', all, ...taskNotes(task.key, key, remote.models, settings.remoteModels));
}

/** Řádek „Hledání podle významu“: výběr embedding modelu poskytovatele, prázdná volba = vypnuto. Seznam se načte až po vykreslení. */
function embedRow(provider: Provider, settings: Settings, save: () => Promise<void>) {
  const slot = provider === 'local' ? 'local' : 'remote';
  const body = h('div', { class: 'stack' });
  const hint = h('p', { class: 'muted small' }, t(provider === 'local' ? 'settings.embed.localHint' : 'settings.embed.remoteHint'));
  window.api.embedModels(provider).then(
    (models) => {
      const chosen = settings.embedModels?.[slot];
      const select = h('select', {}, h('option', { value: '', selected: !chosen }, t('settings.embed.off')));
      if (chosen && !models.some((m) => m.key === chosen)) select.append(h('option', { value: chosen, selected: true }, t('settings.modelMissing', { model: chosen })));
      for (const m of models) select.append(h('option', { value: m.key, selected: m.key === chosen }, m.price ? t('settings.embed.price', { name: m.name, price: usd(m.price.input) }) : m.name));
      select.addEventListener('change', () => {
        settings.embedModels = { ...settings.embedModels, [slot]: select.value || undefined };
        void save();
      });
      body.replaceChildren(select);
    },
    (e) => body.replaceChildren(h('p', { class: 'error-box' }, t('settings.embed.failed', { error: (e as Error).message }))),
  );
  return h('div', { class: 'field task-row' }, h('span', { class: 'task-title' }, t('settings.embed.title')), body, hint);
}

function providerTitle(text: string, active: boolean) {
  return h('h3', { class: 'models-subtitle' }, text, active ? h('span', { class: 'chip accent in-use-now' }, t('settings.inUseNow')) : '');
}

/** Jedna sekce Modely: přepínač poskytovatele (jen volba, co se upravuje) a pod ním model pro každou úlohu. */
function modelsGroup(settings: Settings, lm: LmStatus, remote: LmStatus, url: HTMLInputElement, save: () => Promise<void>, rerender: () => Promise<void>) {
  const local = h('div', { class: 'models-panel stack' }, providerTitle(t('settings.local.title'), settings.provider === 'local'));
  const fills: (() => void)[] = [];
  for (const task of TASKS) {
    const { row, fill } = localTask(task, settings, lm, save);
    fills.push(fill);
    local.append(row);
  }
  // Změna modelu oprav posouvá i „automatický“ model chatu, proto se po změně obnoví všechny řádky.
  local.addEventListener('change', () => fills.forEach((f) => f()));
  local.append(embedRow('local', settings, save));
  local.append(h('label', { class: 'field' }, h('span', {}, t('settings.serverUrl')), url));
  if (!lm.cli) local.append(h('p', { class: 'error-box' }, t('settings.noCli')));

  const online = h('div', { class: 'models-panel stack' }, providerTitle(t('settings.remote.title'), settings.provider === 'openrouter'));
  if (!remote.models.length) online.append(h('p', { class: 'error-box' }, t('settings.remote.noCatalog')));
  for (const task of TASKS) online.append(remoteTask(task, settings, remote, save, rerender));
  if (Object.values(settings.remoteModels).some(isFreeModel)) online.append(h('p', { class: 'muted small' }, t('settings.remote.freeHint')));
  online.append(embedRow('openrouter', settings, save));
  online.append(...remoteExtras(remote, rerender));

  const panels: Record<Provider, HTMLElement> = { local, openrouter: online };
  const tabs = new Map<Provider, HTMLElement>();
  const select = (p: Provider) => {
    editedTab = p;
    for (const [id, panel] of Object.entries(panels)) panel.hidden = id !== p;
    for (const [id, tab] of tabs) {
      tab.classList.toggle('active', id === p);
      tab.setAttribute('aria-checked', String(id === p));
    }
  };
  for (const p of ['local', 'openrouter'] as Provider[]) {
    tabs.set(p, h('button', { class: 'segment', type: 'button', role: 'radio', onclick: () => select(p) }, t(`home.provider.${p}`)));
  }
  select(editedTab ?? settings.provider);
  return h(
    'div',
    { class: 'stack' },
    h('h3', { class: 'models-subtitle' }, t('settings.models.title')),
    h('p', { class: 'muted small' }, t('settings.models.hint')),
    h('div', { class: 'segmented models-switch', role: 'radiogroup', 'aria-label': t('settings.models.title') }, ...tabs.values()),
    local,
    online,
  );
}

/** API klíč OpenRouteru: soukromí, pole a uložení/smazání. */
function keyBlock(lm: LmStatus, rerender: () => Promise<void>) {
  const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: lm.hasKey ? t('settings.remote.keyPlaceholderSaved') : t('settings.remote.keyPlaceholder') });
  const run = (action: () => Promise<void>) => async () => {
    try {
      await action();
      await rerender();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const saveKey = h('button', { class: 'btn', onclick: run(() => window.api.setApiKey(key.value)) }, t('settings.remote.keySave'));
  const removeKey = h('button', { class: 'btn danger', onclick: run(() => window.api.clearApiKey()) }, t('settings.remote.keyRemove'));
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'warn-box' }, t('settings.remote.privacy')),
    h('label', { class: 'field' }, h('span', {}, t('settings.remote.key')), key),
    h('div', { class: 'row gap' }, saveKey, lm.hasKey ? removeKey : ''),
  );
}

/** Online katalog: informace o výběru modelu a obnovení katalogu. */
function remoteExtras(lm: LmStatus, rerender: () => Promise<void>) {
  const refresh = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        try {
          refresh.disabled = true;
          await window.api.refreshCatalog();
          await rerender();
        } catch (e) {
          toast((e as Error).message, true);
        }
      },
    },
    t('settings.remote.refresh'),
  );
  const stamp = lm.catalogAt ? t('settings.remote.catalogAt', { date: new Date(lm.catalogAt).toLocaleString(locale()) }) : '';
  return [h('p', { class: 'muted small' }, t('settings.remote.info')), h('div', { class: 'row gap' }, refresh, h('span', { class: 'muted small' }, stamp))];
}

const usd = (n?: number) => (n === undefined ? '—' : price(n));

const SAMPLE_PAGES = 15;

/** Odhad ceny ukázkového dokumentu s tímto modelem ve všech rolích. */
function sampleCost(m: LmStatus['models'][number], settings: Settings, prices: Record<string, ModelPrice | undefined>) {
  const models = { ocr: m.key, translate: m.key, polish: m.key };
  const usd = estimateCost({ chars: SAMPLE_PAGES * CHARS_PER_PAGE, mode: settings.mode, models, prices }, settings.remoteCostFactors);
  return usd === undefined ? '' : t('settings.remote.estimate', { amount: formatUsd(usd), pages: SAMPLE_PAGES });
}

function modelList(rows: LmStatus['models'], used: string | undefined, onUse: (id: string) => void, sample: (m: LmStatus['models'][number]) => string) {
  const chip = (text: string, cls = '') => h('span', { class: `chip ${cls}` }, text);
  return h(
    'div',
    { class: 'model-list' },
    ...rows.map((m) => {
      const active = m.key === used;
      const cost = m.price && (isFree(m) ? t('settings.remote.free') : t('settings.remote.perM', { input: usd(m.price.input), output: usd(m.price.output) }));
      return h(
        'div',
        { class: `model-card${active ? ' active' : ''}` },
        h(
          'div',
          { class: 'model-info' },
          h('div', { class: 'model-name' }, m.name),
          h('div', { class: 'model-id' }, m.key),
          h(
            'div',
            { class: 'chips' },
            m.key === RECOMMENDED_REMOTE_MODEL ? chip(t('settings.remote.recommended'), 'accent') : '',
            m.key === FAST_REMOTE_MODEL ? chip(t('settings.remote.fast'), 'accent') : '',
            m.vision ? chip(t('settings.remote.vision')) : chip(t('settings.remote.noVisionTag'), 'warn'),
            m.context ? chip(t('settings.remote.context', { n: formatContext(m.context) })) : '',
            cost ? chip(cost) : '',
            !isFree(m) && sample(m) ? chip(sample(m)) : '',
          ),
        ),
        active
          ? h('span', { class: 'model-used' }, icon(ICONS.check), t('settings.remote.inUse'))
          : h('button', { class: 'btn', onclick: () => onUse(m.key) }, t('settings.remote.use')),
      );
    }),
  );
}
