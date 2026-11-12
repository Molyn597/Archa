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
  it('přeložený dokument Srovnání, nepřeložený originál', () => {
    expect(defaultView(true)).toBe('compare');
    expect(topTab(defaultView(true))).toBe('translation');
    expect(defaultView(false)).toBe('original');
  });
});

describe('usableView', () => {
  it('nepřeložený dokument nemá Překlad', () => {
    expect(usableView('compare', false, true)).toBe('original');
    expect(usableView('original', false, false)).toBe('original');
  });

  it('PDF pohledy jen s přeloženým PDF', () => {
    expect(usableView('side-by-side', true, false)).toBe('compare');
    expect(usableView('side-by-side', true, true)).toBe('side-by-side');
    expect(translationViews(false)).toEqual(['translation', 'compare']);
  });
});
