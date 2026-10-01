import { CODE128_PATTERNS, code128Svg, code128Values } from '../src/pdf/code128';

describe('Code 128 encoder (kanban barcodes)', () => {
  it('pattern table is complete: 107 symbols, 11 modules each, STOP = 13', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((p, i) => {
      const sum = [...p].reduce((s, d) => s + Number(d), 0);
      expect({ i, sum }).toEqual({ i, sum: i === 106 ? 13 : 11 });
    });
  });

  it('encodes code set B with start, mod-103 checksum and stop', () => {
    // "AB": A=33, B=34 → (104 + 33·1 + 34·2) mod 103 = 102
    expect(code128Values('AB')).toEqual([104, 33, 34, 102, 106]);
    expect(code128Values('1SH71-012')[0]).toBe(104);
    expect(code128Values('1SH71-012').at(-1)).toBe(106);
  });

  it('replaces characters outside printable ASCII and renders an SVG', () => {
    expect(code128Values('é')).toEqual(code128Values('?'));
    const svg = code128Svg('BRG-6204');
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<rect/g) ?? []).length).toBe(3 * (8 + 3) + 1); // 3 bars per symbol, stop has 4
  });
});
