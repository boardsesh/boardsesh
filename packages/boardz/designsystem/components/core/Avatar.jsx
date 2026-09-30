import React from 'react';

export function Avatar({ name = '', src, size = 32, ring, style }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: src ? 'var(--bg-surface-3) center/cover no-repeat url(' + src + ')' : 'var(--bg-surface-3)', color: 'var(--fg-2)',
      fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: Math.round(size * 0.34), letterSpacing: '0.02em',
      boxShadow: ring ? '0 0 0 2px var(--bg-app), 0 0 0 3.5px ' + ring : 'inset 0 0 0 1px var(--border-1)', ...style,
    }}>{src ? null : initials}</span>
  );
}
