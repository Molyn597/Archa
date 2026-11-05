import { t } from '../shared/i18n';
import { cleanError, h, openModal, toast } from './dom';

/** Poslední známý stav trezoru (zamčené složky); obnovuje se refreshVault a při změně z hlavního procesu. */
export const vault = { exists: false, unlocked: false };

const PING_EVERY = 60_000;
const MIN_LENGTH = 8;

export async function refreshVault() {
  try {
    Object.assign(vault, await window.api.vaultStatus());
  } catch {}
}

/** Odemčený trezor se zamyká po nečinnosti; pohyb v okně to posouvá (nejvýš jednou za minutu). */
export function setupVaultActivity() {
  let last = 0;
  const ping = () => {
    const now = Date.now();
    if (!vault.unlocked || now - last < PING_EVERY) return;
    last = now;
    void window.api.vaultPing().catch(() => undefined);
  };
  for (const type of ['mousemove', 'mousedown', 'keydown']) document.addEventListener(type, ping, { passive: true });
}

const passwordField = (label: string, autofocus = false) => {
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
  if (autofocus) setTimeout(() => input.focus());
  return { input, label: h('label', { class: 'field' }, h('span', {}, label), input) };
};

/** Společná kostra modálu s heslem: chyba přímo v okně, Enter odešle, tlačítko se při práci zamkne. */
function passwordModal(title: string, body: HTMLElement[], action: string, working: string, inputs: HTMLInputElement[], run: () => Promise<void>) {
  const error = h('p', { class: 'error-box', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'button' }, action);
  const close = openModal(title, [...body, error], [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('vault.cancel')), submit]);
  const go = async () => {
    if (submit.disabled) return;
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = working;
    try {
      await run();
      close();
    } catch (e) {
      error.textContent = e instanceof Error && e.message === 'mismatch' ? t('vault.mismatch') : cleanError(e);
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = action;
    }
  };
  submit.addEventListener('click', () => void go());
  for (const input of inputs) input.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
  return submit;
}

/** Modál pro odemknutí; po úspěšném odemknutí zavolá `then`. */
export function unlockModal(then?: () => void | Promise<void>) {
  const pw = passwordField(t('vault.password'), true);
  passwordModal(t('vault.unlockTitle'), [h('p', { class: 'merge-hint' }, t('vault.unlockHint')), pw.label], t('vault.unlock'), t('vault.unlock'), [pw.input], async () => {
    await window.api.vaultUnlock(pw.input.value);
    await refreshVault();
    await then?.();
  });
}

/** Modál pro první nastavení hesla; `then` proběhne po vytvoření trezoru (zamknutí složky). */
function createModal(then: () => Promise<void>) {
  const pw = passwordField(t('vault.password'), true);
  const again = passwordField(t('vault.confirm'));
  const ack = h('input', { type: 'checkbox' });
  let created = false;
  const submit = passwordModal(
    t('vault.createTitle'),
    [
      h('p', { class: 'error-box' }, t('vault.createIntro')),
      h('label', { class: 'merge-row' }, ack, h('span', {}, t('vault.ack'))),
      h('p', { class: 'merge-hint small' }, t('vault.limits')),
      pw.label,
      again.label,
    ],
    t('vault.createAction'),
    t('vault.encrypting'),
    [pw.input, again.input],
    async () => {
      if (pw.input.value.length < MIN_LENGTH) throw new Error(t('vault.short'));
      if (pw.input.value !== again.input.value) throw new Error('mismatch');
      // Po vytvoření trezoru a selhání zamknutí se při opakování heslo znovu nezakládá.
      if (!created) await window.api.vaultCreate(pw.input.value);
      created = true;
      await refreshVault();
      await then();
    },
  );
  submit.disabled = true;
  ack.addEventListener('change', () => (submit.disabled = !ack.checked));
}

/** Zamknutí složky s podsložkami: podle stavu nejdřív nastaví heslo nebo odemkne trezor. `busy` hlásí běžící šifrování. */
export function lockFolder(id: string, busy: (on: boolean) => void) {
  const run = async () => {
    busy(true);
    try {
      await window.api.lockFolder(id, true);
    } finally {
      busy(false);
    }
  };
  const safe = () => run().catch((e) => toast(cleanError(e), true));
  if (!vault.exists) createModal(run);
  else if (!vault.unlocked) unlockModal(safe);
  else void safe();
}

/** Natrvalo zruší zámek složky (dokumenty se dešifrují) po potvrzení. */
export function unlockFolder(id: string, name: string, busy: (on: boolean) => void) {
  if (!confirm(t('vault.confirmUnlock', { name }))) return;
  const run = async () => {
    busy(true);
    try {
      await window.api.lockFolder(id, false);
    } catch (e) {
      toast(cleanError(e), true);
    } finally {
      busy(false);
    }
  };
  if (vault.unlocked) void run();
  else unlockModal(run);
}

/** Změna hesla trezoru (Nastavení). */
export function changePasswordModal(onDone: () => void) {
  const old = passwordField(t('vault.oldPassword'), true);
  const next = passwordField(t('vault.newPassword'));
  const again = passwordField(t('vault.confirm'));
  passwordModal(t('vault.changeTitle'), [h('p', { class: 'warn-box' }, t('vault.forgetWarn')), old.label, next.label, again.label], t('vault.changeAction'), t('vault.changeAction'), [old.input, next.input, again.input], async () => {
    if (next.input.value.length < MIN_LENGTH) throw new Error(t('vault.short'));
    if (next.input.value !== again.input.value) throw new Error('mismatch');
    await window.api.vaultChangePassword(old.input.value, next.input.value);
    toast(t('vault.changed'));
    onDone();
  });
}
