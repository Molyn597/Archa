import { describe, expect, it } from 'vitest';
import { defaultTab, isInfoTab, isTranslated, topTab, topTabs, translationViews, usableView, wasTranslated } from '../src/shared/detail-tabs';
import type { Job, Segment } from '../src/shared/types';

const job = (extra: Partial<Job> = {}) => ({ status: 'done', sourceLang: 'en', targetLang: 'cs', ...extra }) as Job;
const seg = (extra: Partial<Segment> = {}) => ({ id: 1, source: 'a', ...extra }) as Segment;

describe('isTranslated', () => {
  it('přeložené segmenty a různé jazyky', () => {
    expect(isTranslated(job(), [seg({ translation: 'b' })])).toBe(true);
  });

  it('stejný jazyk není překlad', () => {
    expect(isTranslated(job({ targetLang: 'en' }), [seg({ translation: 'b' })])).toBe(false);
  });

  it('bez přeložených segmentů ne, jen citáty pro PDF se nepočítají', () => {
    expect(isTranslated(job(), [seg()])).toBe(false);
    expect(isTranslated(job(), [seg({ translation: 'b', layoutOnly: true })])).toBe(false);
  });

  it('výběr odstavců ano', () => {
    expect(isTranslated(job({ status: 'picking' }), [seg()])).toBe(true);
  });
});

describe('wasTranslated', () => {
  it('hotový dokument s jiným cílovým jazykem', () => {
    expect(wasTranslated(job())).toBe(true);
    expect(wasTranslated(job({ sourceLang: 'cs' }))).toBe(false);
    expect(wasTranslated(job({ sourceLang: 'auto' }))).toBe(false);
    expect(wasTranslated(job({ status: 'running' }))).toBe(false);
  });
});

describe('defaultTab', () => {
  it('faktura a smlouva Přehled', () => {
    expect(defaultTab('invoice', false)).toBe('overview');
    expect(defaultTab('contract', true)).toBe('overview');
  });

  it('přeložený dokument Srovnání, ostatní originál', () => {
    expect(defaultTab('article', true)).toBe('compare');
    expect(topTab(defaultTab('article', true))).toBe('translation');
    expect(defaultTab(undefined, false)).toBe('original');
  });
});

describe('topTabs', () => {
  it('Překlad jen u přeloženého dokumentu', () => {
    expect(topTabs(true)).toEqual(['original', 'translation', 'overview', 'links', 'file']);
    expect(topTabs(false)).toEqual(['original', 'overview', 'links', 'file']);
  });

  it('informační záložky jsou samy sebou', () => {
    expect(isInfoTab('links')).toBe(true);
    expect(isInfoTab('compare')).toBe(false);
    expect(topTab('file')).toBe('file');
    expect(topTab('side-by-side')).toBe('translation');
  });
});

describe('usableView', () => {
  it('nepřeložený dokument nemá Překlad', () => {
    expect(usableView('compare', false, true)).toBe('original');
    expect(usableView('original', false, false)).toBe('original');
    expect(usableView('overview', false, false)).toBe('overview');
  });

  it('PDF pohledy jen s přeloženým PDF', () => {
    expect(usableView('side-by-side', true, false)).toBe('compare');
    expect(usableView('side-by-side', true, true)).toBe('side-by-side');
    expect(translationViews(false)).toEqual(['translation', 'compare']);
  });
});
