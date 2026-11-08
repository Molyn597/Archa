import { describe, expect, it } from 'vitest';
import { defaultView, isTranslated, topTab, translationViews, usableView, wasTranslated } from '../src/shared/detail-tabs';
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

describe('defaultView', () => {
  it('faktura a smlouva O dokumentu i když jsou přeložené', () => {
    expect(defaultView(true, 'invoice')).toBe('about');
    expect(defaultView(true, 'contract')).toBe('about');
  });

  it('přeložený jiný typ Překlad, nepřeložený O dokumentu', () => {
    expect(topTab(defaultView(true, 'article'))).toBe('translation');
    expect(defaultView(false, 'article')).toBe('about');
    expect(defaultView(true)).toBe('compare');
  });
});

describe('usableView', () => {
  it('nepřeložený dokument nemá Překlad', () => {
    expect(usableView('compare', false, true)).toBe('about');
    expect(usableView('original', false, false)).toBe('original');
  });

  it('PDF pohledy jen s přeloženým PDF', () => {
    expect(usableView('side-by-side', true, false)).toBe('compare');
    expect(usableView('side-by-side', true, true)).toBe('side-by-side');
    expect(translationViews(false)).toEqual(['translation', 'compare']);
  });
});
