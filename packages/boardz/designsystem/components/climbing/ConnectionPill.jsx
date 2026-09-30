import React from 'react';
import { Icon } from '../core/Icon.jsx';

const CONN_STATES = {
  disconnected: { dot: 'var(--fg-4)', icon: 'bluetooth-off', text: 'No board', glow: false },
  scanning: { dot: 'var(--led-blue)', icon: 'bluetooth-searching', text: 'Scanning', glow: true },
  connected: { dot: 'var(--led-green)', icon: 'bluetooth-connected', text: 'Connected', glow: true },
  error: { dot: 'var(--led-red)', icon: 'bluetooth-off', text: 'Lost the board', glow: true },
};

export function ConnectionPill({ status = 'disconnected', boardName, onClick, compact, style }) {
  const [hover, setHover] = React.useState(false);
  const s = CONN_STATES[status] || CONN_STATES.disconnected;
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} aria-label={s.text + (boardName ? ' · ' + boardName : '')}
      style={{ display: 'inline-flex', alignItems: 'center', height: 44, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', flexShrink: 0, ...style }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 28, padding: compact ? '0 10px' : '0 12px 0 10px', borderRadius: 'var(--radius-pill)',
        boxShadow: 'inset 0 0 0 1px ' + (hover ? 'var(--border-strong)' : 'var(--border-2)'), color: 'var(--fg-2)',
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap', transition: 'box-shadow var(--dur-fast)' }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: s.dot, color: s.dot,
          boxShadow: s.glow ? '0 0 6px 1px color-mix(in srgb, ' + s.dot + ' 70%, transparent)' : 'none',
          animation: status === 'scanning' ? 'bz-pulse 1.4s var(--ease-out) infinite' : 'none' }} />
        {compact ? <Icon name={s.icon} size={14} /> : <span>{status === 'connected' && boardName ? boardName : s.text}</span>}
      </span>
    </button>
  );
}
