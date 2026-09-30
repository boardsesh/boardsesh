import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function VideoThumb({ title, author, duration, meta, src, aspect = '9 / 16', onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div role="button" tabIndex={0} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', minWidth: 0, ...style }}>
      <div style={{ position: 'relative', aspectRatio: aspect, borderRadius: 'var(--radius-md)', overflow: 'hidden', boxShadow: '0 0 0 1px var(--board-panel-edge)',
        background: src ? 'center/cover no-repeat url(' + src + ')' : 'repeating-linear-gradient(135deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 9px), var(--board-panel)' }}>
        {!src ? <span style={{ position: 'absolute', left: 10, top: 10, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--board-label)', letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase' }}>Beta</span> : null}
        <span style={{ position: 'absolute', left: '50%', top: '50%', width: 40, height: 40, marginLeft: -20, marginTop: -20, borderRadius: 20, background: 'rgba(244,243,239,0.92)', color: '#151618', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: hover ? 'scale(1.06)' : 'none', transition: 'transform var(--dur-base) var(--ease-out)' }}>
          <Icon name="play" size={16} fill="currentColor" style={{ marginLeft: 2 }} />
        </span>
        {duration ? <span style={{ position: 'absolute', right: 8, bottom: 8, padding: '3px 6px', borderRadius: 4, background: 'rgba(14,15,16,0.78)', color: '#EDECE8', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1 }}>{duration}</span> : null}
      </div>
      {title || author ? (
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {title ? <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div> : null}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[author, meta].filter(Boolean).join(' · ')}</div>
        </div>
      ) : null}
    </div>
  );
}
