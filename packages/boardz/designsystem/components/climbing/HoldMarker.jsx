import React from 'react';

export const LED_SETS = {
  moon: { start: 'var(--led-moon-start)', hand: 'var(--led-moon-hand)', foot: 'var(--led-moon-foot)', finish: 'var(--led-moon-finish)' },
  kilter: { start: 'var(--led-kilter-start)', hand: 'var(--led-kilter-hand)', foot: 'var(--led-kilter-foot)', finish: 'var(--led-kilter-finish)' },
  tension: { start: 'var(--led-tension-start)', hand: 'var(--led-tension-hand)', foot: 'var(--led-tension-foot)', finish: 'var(--led-tension-finish)' },
};
const HOLD_LABELS = { start: 'Start', hand: 'Hand', foot: 'Foot', finish: 'Finish' };

export function ledGlow(color, blur = 12, spread = 2) {
  return '0 0 ' + blur + 'px ' + spread + 'px color-mix(in srgb, ' + color + ' 55%, transparent)';
}

export function HoldMarker({ role = 'hand', board = 'moon', size = 14, label, lit = true, style }) {
  const color = (LED_SETS[board] || LED_SETS.moon)[role];
  const ring = (
    <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, border: Math.max(1.5, Math.round(size * 0.13)) + 'px solid ' + color,
      background: 'color-mix(in srgb, ' + color + ' 16%, transparent)', boxShadow: lit ? ledGlow(color, Math.round(size * 0.7), Math.max(1, Math.round(size * 0.1))) : 'none' }} />
  );
  if (!label) return ring;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--fg-2)', ...style }}>
      {ring}{label === true ? HOLD_LABELS[role] : label}
    </span>
  );
}
