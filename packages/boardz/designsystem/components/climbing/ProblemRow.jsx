import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Badge } from '../core/Badge.jsx';
import { GradeBadge } from './GradeBadge.jsx';

export function ProblemRow({ problem = {}, index, selected, onClick, onFavorite, divider = true, style }) {
  const [hover, setHover] = React.useState(false);
  const p = problem;
  const q = p.quality != null ? p.quality : p.stars != null ? Number(p.stars).toFixed(1) : null;
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 11 };
  return (
    <div role="button" tabIndex={0} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onKeyDown={e => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 62, padding: '0 20px', cursor: 'pointer',
        borderBottom: divider ? '1px solid var(--border-1)' : 0,
        background: selected ? 'var(--bg-surface-3)' : hover ? 'var(--bg-surface-2)' : 'transparent', transition: 'background var(--dur-fast)', ...style }}>
      {index != null ? <span style={{ ...mono, width: 24, flexShrink: 0, color: 'var(--fg-3)' }}>{String(index).padStart(2, '0')}</span> : null}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.015em', color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {p.setter ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.setter}</span> : null}
          {p.ascents != null ? <span style={mono}>{p.ascents}</span> : null}
          {q != null ? <span style={mono}>★{q}</span> : null}
          {p.benchmark ? <Badge mono outline size="xs">BM</Badge> : null}
        </div>
      </div>
      {onFavorite ? (
        <button type="button" aria-label={p.favorite ? 'Unfavorite' : 'Favorite'} onClick={e => { e.stopPropagation(); onFavorite(); }}
          style={{ border: 0, background: 'transparent', width: 36, height: 44, padding: 0, cursor: 'pointer', color: p.favorite ? 'var(--fg-1)' : 'var(--fg-4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="heart" size={17} fill={p.favorite ? 'currentColor' : 'none'} />
        </button>
      ) : null}
      <GradeBadge grade={p.grade} variant={p.sent ? 'solid' : 'outline'} />
    </div>
  );
}
