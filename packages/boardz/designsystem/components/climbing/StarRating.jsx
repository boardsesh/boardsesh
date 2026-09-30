import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function StarRating({ value = 0, max = 3, size = 16, onChange, style }) {
  const [hov, setHov] = React.useState(null);
  const shown = hov != null ? hov : value;
  const stars = [];
  for (let i = 1; i <= max; i++) {
    const on = i <= shown;
    const el = <Icon key={i} name="star" size={size} strokeWidth={1.5} color={on ? 'var(--star)' : 'var(--border-strong)'} fill={on ? 'var(--star)' : 'none'} />;
    stars.push(onChange ? (
      <button key={i} type="button" aria-label={i + ' star'} onClick={() => onChange(i === value ? 0 : i)} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
        style={{ border: 0, background: 'transparent', padding: 6, minWidth: 44, minHeight: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{el}</button>
    ) : el);
  }
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: onChange ? 0 : 2, ...style }} aria-label={value + ' of ' + max + ' stars'}>{stars}</span>;
}
