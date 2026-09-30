import React from 'react';

const GRADE_SIZES = { sm: [26, 40, 12, 7], md: [30, 50, 14, 8], lg: [40, 64, 18, 10], xl: [56, 88, 24, 12] };
const DISPLAY_FS = { sm: 32, md: 48, lg: 64, xl: 88 };
const FONT_ORDER = ['4', '4+', '5', '5+', '6A', '6A+', '6B', '6B+', '6C', '6C+', '7A', '7A+', '7B', '7B+', '7C', '7C+', '8A', '8A+', '8B', '8B+', '8C', '8C+', '9A'];
const FONT_BAND = { '6B': 2, '6B+': 2, '6C': 3, '6C+': 3, '7A': 4, '7A+': 4, '7B': 5, '7B+': 5, '7C': 6, '7C+': 6 };

// 1–7 difficulty band for a Font ("7A+") or V ("V8") grade; 0 if unknown.
export function gradeBand(grade) {
  const g = String(grade || '').trim().toUpperCase();
  const v = /^V(\d+)/.exec(g);
  if (v) { const n = +v[1]; return n <= 3 ? 1 : n === 4 ? 2 : n === 5 ? 3 : n <= 7 ? 4 : n === 8 ? 5 : n <= 10 ? 6 : 7; }
  if (FONT_BAND[g]) return FONT_BAND[g];
  const i = FONT_ORDER.indexOf(g);
  if (i < 0) return 0;
  return i < FONT_ORDER.indexOf('6B') ? 1 : 7;
}

export function GradeBadge({ grade, size = 'md', variant = 'outline', benchmark, coded = true, style }) {
  const band = coded ? gradeBand(grade) : 0;
  const c = band ? 'var(--grade-' + band + ')' : 'var(--fg-1)';
  if (variant === 'display') {
    return <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 300, fontSize: DISPLAY_FS[size] || 64, letterSpacing: 'var(--tracking-readout)', lineHeight: 0.78, color: c, whiteSpace: 'nowrap', ...style }}>{grade}</span>;
  }
  const [h, w, fs, r] = GRADE_SIZES[size] || GRADE_SIZES.md;
  const solid = variant === 'solid' || variant === 'accent';
  const soft = variant === 'soft';
  const bg = solid ? (band ? c : 'var(--accent)') : soft ? 'color-mix(in srgb, ' + c + ' 16%, transparent)' : band ? 'color-mix(in srgb, ' + c + ' 9%, transparent)' : 'transparent';
  const fg = solid ? (band ? 'var(--grade-on)' : 'var(--fg-on-accent)') : c;
  const ring = solid || soft ? 'none' : 'inset 0 0 0 1px ' + (band ? 'color-mix(in srgb, ' + c + ' 50%, transparent)' : 'var(--border-strong)');
  return (
    <span data-grade-band={band || undefined} style={{ position: 'relative', minWidth: w, height: h, padding: '0 8px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: bg, color: fg, boxShadow: ring, borderRadius: r,
      fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: fs, letterSpacing: '-0.02em', lineHeight: 1, ...style }}>
      {grade}
      {benchmark ? <span title="Benchmark" style={{ position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 2, background: c, boxShadow: '0 0 0 2px var(--bg-app)' }} /> : null}
    </span>
  );
}
