import React from 'react';

export function Tabs({ items = [], value, onChange, style }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 22, borderBottom: '1px solid var(--border-2)', overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none', ...style }}>
      {items.map(it => {
        const on = it.value === value;
        return (
          <button key={it.value} role="tab" aria-selected={on} type="button" onClick={() => onChange && onChange(it.value)}
            style={{ position: 'relative', height: 44, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7,
              fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: on ? 600 : 500, color: on ? 'var(--fg-1)' : 'var(--fg-3)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {it.label}
            {it.count != null ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 400, color: 'var(--fg-3)' }}>{it.count}</span> : null}
            <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, background: on ? 'var(--fg-1)' : 'transparent' }} />
          </button>
        );
      })}
    </div>
  );
}
