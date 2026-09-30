import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function StatTile({ label, value, unit, delta, icon, variant = 'tile', style }) {
  const cell = variant === 'cell';
  const down = delta && String(delta).trim()[0] === '-';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: cell ? 6 : 12, padding: cell ? '10px 0' : 16, minWidth: 0,
      background: cell ? 'transparent' : 'var(--bg-surface)', boxShadow: cell ? 'none' : 'inset 0 0 0 1px var(--border-1)', borderRadius: cell ? 0 : 'var(--radius-lg)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: cell ? 9 : 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--fg-3)', lineHeight: 1 }}>
        {icon ? <Icon name={icon} size={13} /> : null}{label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: cell ? 17 : 30, fontWeight: cell ? 400 : 300, letterSpacing: cell ? '-0.02em' : '-0.05em', lineHeight: 1, color: 'var(--fg-1)' }}>{value}</span>
        {unit ? <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{unit}</span> : null}
      </div>
      {delta ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: down ? 'var(--danger)' : 'var(--success)' }}>{down ? '↓ ' : '↑ '}{String(delta).replace(/^[+-]/, '')}</div> : null}
    </div>
  );
}

export function ReadoutStrip({ items = [], style }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(' + Math.max(1, items.length) + ', minmax(0, 1fr))', borderTop: '1px solid var(--border-2)', borderBottom: '1px solid var(--border-2)', ...style }}>
      {items.map((it, i) => (
        <StatTile key={i} variant="cell" label={it.label} value={it.value} unit={it.unit} style={{ paddingLeft: i ? 12 : 0, borderLeft: i ? '1px solid var(--border-2)' : 0 }} />
      ))}
    </div>
  );
}
