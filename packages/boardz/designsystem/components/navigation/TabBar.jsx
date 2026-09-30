import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function TabBar({ items = [], value, onChange, style }) {
  return (
    <nav style={{ display: 'flex', height: 'var(--tabbar-h)', background: 'var(--bg-app)', borderTop: '1px solid var(--border-2)', padding: '0 4px', flexShrink: 0, ...style }}>
      {items.map(it => {
        const on = it.value === value;
        return (
          <button key={it.value} type="button" onClick={() => onChange && onChange(it.value)} aria-current={on ? 'page' : undefined}
            style={{ flex: 1, position: 'relative', border: 0, background: 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
              color: on ? 'var(--fg-1)' : 'var(--fg-3)', fontSize: 10, fontWeight: on ? 600 : 500, fontFamily: 'var(--font-sans)' }}>
            <span style={{ position: 'absolute', top: -1, width: 20, height: 2, borderRadius: 1, background: on ? 'var(--fg-1)' : 'transparent' }} />
            <Icon name={it.icon} size={22} />
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}
