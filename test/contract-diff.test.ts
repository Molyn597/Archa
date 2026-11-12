import { describe, expect, it } from 'vitest';
import { changeCount, changesText, diffContracts, headingOf, isNewer, versionDate, wordDiff, type Para } from '../src/shared/contract-diff';
import type { DocumentCard } from '../src/shared/types';

const paras = (...texts: string[]): Para[] => texts.map((text, i) => ({ text, seg: i + 1 }));

const OLD = paras(
  'NÁJEMNÍ SMLOUVA',
  'Čl. I – Předmět nájmu',
  'Pronajímatel přenechává nájemci do užívání dílnu o výměře 180 m².',
  'Čl. II – Doba nájmu',
  'Nájem se sjednává na dobu neurčitou.',
  'Výpovědní lhůta činí 3 měsíce a běží od prvního dne následujícího měsíce.',
  'Výpověď musí být doručena doporučeným dopisem.',
  'Čl. III – Předkupní právo',
  'Nájemce má předkupní právo k vybavení dílny.',
);

describe('diffContracts', () => {
  it('stejné dokumenty nemají žádnou změnu', () => {
    const s = diffContracts(OLD, OLD);
    expect(changeCount(s)).toBe(0);
    expect(s.map((x) => x.title)).toEqual(['', 'Čl. I – Předmět nájmu', 'Čl. II – Doba nájmu', 'Čl. III – Předkupní právo']);
  });

  it('jiné číslo ve větě je jedna změna s rozdílem po slovech', () => {
    const next = OLD.map((p) => (p.text.startsWith('Výpovědní') ? { ...p, text: 'Výpovědní lhůta činí 6 měsíců a běží od prvního dne následujícího měsíce.' } : p));
    const s = diffContracts(OLD, next);
    expect(changeCount(s)).toBe(1);
    const row = s.flatMap((x) => x.rows).find((r) => r.kind === 'chg')!;
    expect(row.aSeg).toBe(6);
    expect(row.aParts?.filter((p) => p.kind === 'del').map((p) => p.text)).toEqual(['3 měsíce']);
    expect(row.bParts?.filter((p) => p.kind === 'ins').map((p) => p.text)).toEqual(['6 měsíců']);
    expect(row.bParts?.map((p) => p.text).join('')).toBe('Výpovědní lhůta činí 6 měsíců a běží od prvního dne následujícího měsíce.');
  });

  it('nový článek se ukáže celý jako nový, i když posune čísla dalších', () => {
    const next = [...OLD.slice(0, 7), ...paras('Čl. III – Sankce', 'Při prodlení zaplatí nájemce smluvní pokutu 0,1 % denně.'), { text: 'Čl. IV – Předkupní právo' }, OLD[8]];
    const s = diffContracts(OLD, next);
    expect(changeCount(s)).toBe(1);
    const added = s.find((x) => x.title === 'Čl. III – Sankce')!;
    expect(added.rows).toEqual([{ kind: 'add', b: 'Při prodlení zaplatí nájemce smluvní pokutu 0,1 % denně.', bSeg: 2 }]);
    expect(s.find((x) => x.title === 'Čl. IV – Předkupní právo')!.rows.every((r) => r.kind === 'same')).toBe(true);
  });

  it('odebraný odstavec a odebraný článek', () => {
    const next = [...OLD.slice(0, 6)];
    const s = diffContracts(OLD, next);
    const rows = s.flatMap((x) => x.rows.map((r) => [x.title, r.kind, r.a]));
    expect(rows.filter((r) => r[1] === 'del')).toEqual([
      ['Čl. II – Doba nájmu', 'del', 'Výpověď musí být doručena doporučeným dopisem.'],
      ['Čl. III – Předkupní právo', 'del', 'Nájemce má předkupní právo k vybavení dílny.'],
    ]);
  });

  it('jen mezery, zalomení, uvozovky a velikost písmen nejsou změna', () => {
    const a = paras('Nájemce zaplatí „nájemné“ do 15. dne v měsíci.', 'Strana 1 z 3');
    const b = paras('Nájemce  zaplatí "nájemné"\ndo 15. dne v Měsíci.', '- 2 -');
    expect(changeCount(diffContracts(a, b))).toBe(0);
  });

  it('dokument bez nadpisů je jeden oddíl', () => {
    const s = diffContracts(paras('První odstavec.', 'Druhý odstavec.'), paras('První odstavec.', 'Úplně jiný text o něčem dalším.'));
    expect(s).toHaveLength(1);
    expect(s[0].title).toBe('');
    expect(s[0].rows.map((r) => r.kind)).toEqual(['same', 'del', 'add']);
  });

  it('přejmenovaný článek je změna nadpisu', () => {
    const next = OLD.map((p) => (p.text === 'Čl. II – Doba nájmu' ? { ...p, text: 'Čl. II – Doba nájmu a výpověď' } : p));
    const s = diffContracts(OLD, next);
    expect(changeCount(s)).toBe(1);
    expect(s[2].title).toBe('Čl. II – Doba nájmu a výpověď');
    expect(s[2].rows[0].kind).toBe('chg');
  });
});

describe('headingOf', () => {
  it.each([
    ['Čl. III', 3],
    ['Článek 3', 3],
    ['čl. 3.', 3],
    ['§ 3 Doba nájmu', 3],
    ['Article 4 – Term', 4],
    ['III. Doba nájmu', 3],
    ['12. Závěrečná ustanovení', 12],
  ])('%s je nadpis', (text, n) => expect(headingOf({ text })?.n).toBe(n));

  it.each(['Nájemce zaplatí nájemné.', '1. Nájemce zaplatí nájemné do 15. dne.', '3.1 Podrobnosti', 'Smluvní strany se dohodly takto'])('%s není nadpis', (text) => expect(headingOf({ text })).toBeUndefined());

  it('nadpis slepený s textem článku zůstane i jako odstavec', () => {
    const h = headingOf({ text: 'Čl. IV Sankce Při prodlení s placením nájemného zaplatí nájemce smluvní pokutu ve výši 0,1 % z dlužné částky za každý den.' });
    expect(h).toMatchObject({ title: 'Čl. IV', n: 4, body: true });
  });

  it('krátký segment typu nadpis bez čísla', () => expect(headingOf({ text: 'Doba nájmu', heading: true })?.name).toBe('doba nájmu'));
});

describe('wordDiff', () => {
  it('číslo s mezerou mezi tisíci je jedno slovo', () => {
    const d = wordDiff('Cena činí 4 500 Kč měsíčně.', 'Cena činí 4 900 Kč měsíčně.');
    expect(d.aParts.filter((p) => p.kind === 'del').map((p) => p.text)).toEqual(['4 500']);
    expect(d.bParts.filter((p) => p.kind === 'ins').map((p) => p.text)).toEqual(['4 900']);
  });

  it('spojí sousední změněná slova i s mezerou', () => {
    const d = wordDiff('na dobu neurčitou.', 'na dobu určitou do 31. 12. 2029.');
    expect(d.aParts).toEqual([{ text: 'na dobu ', kind: 'same' }, { text: 'neurčitou', kind: 'del' }, { text: '.', kind: 'same' }]);
    expect(d.bParts.find((p) => p.kind === 'ins')?.text).toBe('určitou do 31. 12. 2029');
  });
});

describe('changesText', () => {
  it('jen změněné řádky a zkrácení na limit', () => {
    const next = OLD.map((p) => (p.text.startsWith('Výpovědní') ? { ...p, text: 'Výpovědní lhůta činí 6 měsíců a běží od prvního dne následujícího měsíce.' } : p)).slice(0, 7);
    const text = changesText(diffContracts(OLD, next), 10000);
    expect(text.split('\n')).toEqual([
      'Čl. II – Doba nájmu: – Výpovědní lhůta činí 3 měsíce a běží od prvního dne následujícího měsíce. / + Výpovědní lhůta činí 6 měsíců a běží od prvního dne následujícího měsíce.',
      'Čl. III – Předkupní právo: – Nájemce má předkupní právo k vybavení dílny.',
    ]);
    expect(changesText(diffContracts(OLD, next), 40)).toHaveLength(40);
  });
});

describe('pořadí verzí', () => {
  const card = (facts: DocumentCard['facts']) => ({ facts }) as DocumentCard;
  it('datum z karty má přednost před přidáním', () => {
    expect(versionDate(Date.UTC(2026, 5, 1, 12), card({ issued: '2024-01-02' }))).toBe('2024-01-02');
    expect(isNewer({ createdAt: 1, card: card({ validFrom: '2027-01-01' }) }, { createdAt: 2, card: card({ validFrom: '2026-01-01' }) })).toBe(true);
    expect(isNewer({ createdAt: 1 }, { createdAt: 2 })).toBe(false);
  });
});
