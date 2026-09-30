import React from 'react';
import { Icon } from './Icon.jsx';

const BTN_SIZES = { sm: { h: 32, px: 12, fs: 13, ic: 16 }, md: { h: 40, px: 16, fs: 14, ic: 18 }, lg: { h: 48, px: 20, fs: 15, ic: 19 }, xl: { h: 56, px: 24, fs: 16, ic: 20 } };
const BTN_VARIANTS = {
  primary: { bg: 'var(--accent)', hover: 'var(--accent-hover)', press: 'var(--accent-press)', fg: 'var(--fg-on-accent)', ring: null, weight: 600 },
  secondary: { bg: 'transparent', hover: 'var(--bg-surface-3)', press: 'var(--bg-surface-3)', fg: 'var(--fg-1)', ring: 'var(--border-2)', weight: 500 },
  tonal: { bg: 'var(--bg-surface-3)', hover: 'var(--border-1)', press: 'var(--border-2)', fg: 'var(--fg-1)', ring: null, weight: 500 },
  ghost: { bg: 'transparent', hover: 'var(--bg-surface-3)', press: 'var(--bg-surface-3)', fg: 'var(--fg-1)', ring: null, weight: 500 },
  danger: { bg: 'transparent', hover: 'var(--danger-soft)', press: 'var(--danger-soft)', fg: 'var(--danger)', ring: 'var(--danger)', weight: 500 },
};
BTN_VARIANTS.inverse = BTN_VARIANTS.tonal;

export function Button({ children, variant = 'primary', size = 'md', icon, iconRight, led, fullWidth, loading, disabled, onClick, type = 'button', style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const s = BTN_SIZES[size] || BTN_SIZES.md;
  const v = BTN_VARIANTS[variant] || BTN_VARIANTS.primary;
  const off = disabled || loading;
  const ledColor = led === true ? 'var(--hold-hand)' : led;
  return (
    <button type={type} disabled={off} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)} onMouseUp={() => setPress(false)}
      style={{
        display: fullWidth ? 'flex' : 'inline-flex', width: fullWidth ? '100%' : undefined, alignItems: 'center', justifyContent: 'center', gap: ledColor ? 10 : 8,
        height: s.h, padding: '0 ' + s.px + 'px', fontFamily: 'var(--font-sans)', fontSize: s.fs, fontWeight: v.weight, letterSpacing: '-0.01em',
        color: v.fg, background: !off && press ? v.press : !off && hover ? v.hover : v.bg, border: 0,
        boxShadow: v.ring ? 'inset 0 0 0 1px ' + v.ring : 'none',
        borderRadius: 'var(--radius-md)', cursor: off ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
        transform: press && !off ? 'scale(0.98)' : 'none',
        transition: 'background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)', whiteSpace: 'nowrap', ...style,
      }} {...rest}>
      {loading ? <Icon name="loader-circle" size={s.ic} style={{ animation: 'bz-spin 0.8s linear infinite' }} />
        : ledColor ? <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: ledColor, boxShadow: '0 0 8px 2px color-mix(in srgb, ' + ledColor + ' 60%, transparent)' }} />
        : icon ? <Icon name={icon} size={s.ic} /> : null}
      {children != null && children !== false ? <span style={{ whiteSpace: 'nowrap' }}>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={s.ic} /> : null}
    </button>
  );
}
