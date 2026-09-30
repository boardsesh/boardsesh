import React from 'react';

const BADGE_TONES = {
  neutral: ['var(--bg-surface-3)', 'var(--fg-2)', 'var(--border-2)'],
  accent: ['var(--accent)', 'var(--fg-on-accent)', 'var(--fg-1)'],
  success: ['var(--success-soft)', 'var(--success)', 'var(--success)'],
  danger: ['var(--danger-soft)', 'var(--danger)', 'var(--danger)'],
  warning: ['var(--warning-soft)', 'var(--warning)', 'var(--warning)'],
  info: ['var(--info-soft)', 'var(--info)', 'var(--info)'],
  inverse: ['var(--bg-inverse)', 'var(--fg-inverse)', 'var(--bg-inverse)'],
};
const BADGE_DOTS = { success: 'var(--led-green)', danger: 'var(--led-red)', warning: 'var(--led-amber)', info: 'var(--led-blue)' };
const BADGE_SIZES = { xs: [16, 4, 9], sm: [20, 6, 10], md: [24, 8, 12] };

export function Badge({ children, tone = 'neutral', size = 'md', outline, dot, mono, style }) {
  const [bg, fg, ring] = BADGE_TONES[tone] || BADGE_TONES.neutral;
  const [h, px, fs] = BADGE_SIZES[size] || BADGE_SIZES.md;
  const dc = BADGE_DOTS[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: h, padding: '0 ' + px + 'px', flexShrink: 0,
      background: outline ? 'transparent' : bg, color: outline && tone === 'neutral' ? 'var(--fg-2)' : fg,
      boxShadow: outline ? 'inset 0 0 0 1px ' + ring : 'none',
      borderRadius: size === 'xs' ? 'var(--radius-xs)' : 'var(--radius-sm)',
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontSize: mono ? Math.max(9, fs - 2) : fs, fontWeight: mono ? 400 : 500,
      letterSpacing: mono ? 'var(--tracking-label)' : 0, textTransform: mono ? 'uppercase' : 'none', whiteSpace: 'nowrap', lineHeight: 1, ...style,
    }}>
      {dot ? <span style={{ width: 6, height: 6, borderRadius: 3, background: dc || 'currentColor', boxShadow: dc ? '0 0 6px 1px color-mix(in srgb, ' + dc + ' 60%, transparent)' : 'none' }} /> : null}
      {children}
    </span>
  );
}
