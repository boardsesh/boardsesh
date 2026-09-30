import React from 'react';
import { Icon } from '../core/Icon.jsx';

const SEG_H = { sm: 32, md: 40, lg: 44, xl: 56 };

export function SegmentedControl({ options = [], value, onChange, multiple, size = 'md', fullWidth, style }) {
  const opts = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);
  const h = SEG_H[size] || SEG_H.md;
  const sel = multiple ? (Array.isArray(value) ? value : []) : null;
  const isOn = v => multiple ? sel.includes(v) : v === value;
  const pick = v => { if (!onChange) return; if (multiple) onChange(isOn(v) ? sel.filter(x => x !== v) : [...sel, v]); else onChange(v); };
  return (
    <div role={multiple ? 'group' : 'radiogroup'} style={{ display: fullWidth ? 'flex' : 'inline-flex', height: h, borderRadius: 'var(--radius-md)', boxShadow: 'inset 0 0 0 1px var(--border-2)', overflow: 'hidden', flexShrink: 0, ...style }}>
      {opts.map((o, i) => {
        const on = isOn(o.value);
        return (
          <button key={o.value} type="button" role={multiple ? undefined : 'radio'} aria-checked={multiple ? undefined : on} aria-pressed={multiple ? on : undefined} onClick={() => pick(o.value)}
            style={{ flex: fullWidth ? (o.grow || 1) : undefined, minWidth: 0, padding: '0 14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              border: 0, borderLeft: i ? '1px solid var(--border-2)' : 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: size === 'sm' ? 13 : size === 'xl' ? 15 : 14, fontWeight: 500, whiteSpace: 'nowrap',
              background: on ? 'var(--accent)' : 'transparent', color: on ? 'var(--fg-on-accent)' : 'var(--fg-2)',
              transition: 'background var(--dur-fast), color var(--dur-fast)' }}>
            {o.icon ? <Icon name={o.icon} size={16} /> : null}<span style={{ whiteSpace: 'nowrap' }}>{o.label}</span>{o.iconRight ? <Icon name={o.iconRight} size={13} /> : null}
          </button>
        );
      })}
    </div>
  );
}
