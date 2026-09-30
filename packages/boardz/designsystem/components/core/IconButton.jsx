import React from 'react';
import { Icon } from './Icon.jsx';

const IBTN_SIZES = { sm: [32, 16], md: [40, 20], lg: [48, 20], xl: [56, 22] };

export function IconButton({ icon, label, variant = 'ghost', size = 'md', active, activeColor, round, disabled, onClick, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const [d, ic] = IBTN_SIZES[size] || IBTN_SIZES.md;
  const primary = variant === 'primary';
  const bg = primary ? 'var(--accent)' : variant === 'tonal' ? 'var(--bg-surface-3)' : 'transparent';
  const hoverBg = primary ? 'var(--accent-hover)' : variant === 'tonal' ? 'var(--border-1)' : 'var(--bg-surface-3)';
  const fg = primary ? 'var(--fg-on-accent)' : active ? (activeColor || 'var(--fg-1)') : hover ? 'var(--fg-1)' : 'var(--fg-2)';
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)} onMouseUp={() => setPress(false)}
      style={{
        width: d, height: d, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0, border: 0,
        background: hover && !disabled ? hoverBg : bg, color: fg,
        boxShadow: variant === 'secondary' ? 'inset 0 0 0 1px var(--border-2)' : 'none',
        borderRadius: round ? 'var(--radius-pill)' : 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
        transform: press && !disabled ? 'scale(0.94)' : 'none',
        transition: 'background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), color var(--dur-fast)', ...style,
      }} {...rest}>
      <Icon name={icon} size={ic} fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}
