import { describe, expect, it } from 'vitest';
import { contractRisksPrompt, parseRisks } from '../src/main/risks';
import { findQuoteSegment } from '../src/shared/risks';
import type { Segment } from '../src/shared/types';

const CONTRACT =
  'Čl. III Doba nájmu\nNájem se sjednává na dobu určitou do 31. 12. 2029 a automaticky se prodlužuje o další 3 roky, ' +
  'pokud nájemce nejméně 6 měsíců před jeho uplynutím písemně neoznámí, že na prodloužení netrvá.\n' +
  'Čl. IV Sankce\nPři prodlení s placením nájemného zaplatí nájemce smluvní pokutu ve výši 0,5 % z dlužné ' +
  'částky za každý den prodlení.';

const answer = (risks: unknown[]) => `\`\`\`json\n${JSON.stringify({ risks })}\n\`\`\``;

describe('parseRisks', () => {
  it('nechá doslovné citace, seřadí podle závažnosti', () => {
    const r = parseRisks(
      answer([
        { severity: 'medium', title: 'Vysoká pokuta', quote: 'smluvní pokutu ve výši 0,5 % z dlužné částky za každý den prodlení', why: 'Ročně přes 180 %.', tip: '' },
        { severity: 'high', title: 'Automatické prodloužení', quote: 'automaticky se prodlužuje o další 3 roky', why: 'Snadno se zapomene.', tip: 'Zapiš si termín.' },
      ]),
      CONTRACT,
    );
    expect(r?.map((x) => x.severity)).toEqual(['high', 'medium']);
    expect(r?.[0].tip).toBe('Zapiš si termín.');
    expect(r?.[1].tip).toBeUndefined();
  });

  it('zahodí vymyšlenou nebo přeformulovanou citaci a neplatnou závažnost', () => {
    const r = parseRisks(
      answer([
        { severity: 'high', title: 'Rozhodčí doložka', quote: 'Spory rozhodne rozhodčí soud.', why: 'x' },
        { severity: 'urgent', title: 'Pokuta', quote: 'za každý den prodlení', why: 'x' },
      ]),
      CONTRACT,
    );
    expect(r).toEqual([]);
  });

  it('najde citaci i přes jiné mezery, zalomení a uvozovky', () => {
    const r = parseRisks(answer([{ severity: 'low', title: 'Lhůta', quote: 'nejméně  6 měsíců před jeho uplynutím\npísemně neoznámí', why: 'x' }]), CONTRACT);
    expect(r).toHaveLength(1);
  });

  it('bez JSON nebo bez pole risks vrátí undefined', () => {
    expect(parseRisks('nevím', CONTRACT)).toBeUndefined();
    expect(parseRisks('{"x": 1}', CONTRACT)).toBeUndefined();
  });
});

describe('contractRisksPrompt', () => {
  it('posuzuje za vlastní firmu, když je známá', () => {
    expect(contractRisksPrompt('text', 'cs', 'Pila Servis s.r.o.')).toContain('the party "Pila Servis s.r.o."');
    expect(contractRisksPrompt('text', 'cs')).toContain('customer, tenant');
    expect(contractRisksPrompt('text', 'cs')).toContain('in Czech.');
  });
});

const seg = (id: number, source: string, extra: Partial<Segment> = {}): Segment => ({ id, kind: 'paragraph', source, ...extra });

describe('findQuoteSegment', () => {
  const segments = [
    seg(1, 'Čl. I Předmět'),
    seg(2, 'Nájem se sjednává na dobu určitou a automaticky se pro-\ndlužuje o další „3 roky“.'),
    seg(3, 'Smluvní pokuta činí 0,5 % denně z dlužné částky a je splatná do 3 dnů od výzvy.'),
    seg(4, 'Rozhodčí doložka: spory řeší výhradně rozhodce v Bratislavě,', { layoutOnly: true }),
    seg(5, 'a to bez možnosti odvolání ke státnímu soudu.'),
  ];

  it('přesná shoda', () => {
    expect(findQuoteSegment(segments, 'Smluvní pokuta činí 0,5 % denně')?.id).toBe(3);
  });

  it('jiné uvozovky, mezery a dělení slov', () => {
    expect(findQuoteSegment(segments, 'AUTOMATICKY  se prodlužuje o další "3 roky"')?.id).toBe(2);
  });

  it('citace přes dva segmenty: segment, kde začíná', () => {
    const two = [seg(1, 'Úvodní ustanovení smlouvy o dílo.'), seg(2, 'Zhotovitel odpovídá za škodu pouze do výše ceny díla,'), seg(3, 'a to jen za škodu způsobenou úmyslně.')];
    expect(findQuoteSegment(two, 'Zhotovitel odpovídá za škodu pouze do výše ceny díla, a to jen za škodu způsobenou úmyslně.')?.id).toBe(2);
  });

  it('přeskočí layoutOnly a nenalezené vrátí undefined', () => {
    expect(findQuoteSegment(segments, 'výhradně rozhodce v Bratislavě')).toBeUndefined();
    expect(findQuoteSegment(segments, 'věta, která ve smlouvě není')).toBeUndefined();
    expect(findQuoteSegment(segments, '  ')).toBeUndefined();
  });
});
