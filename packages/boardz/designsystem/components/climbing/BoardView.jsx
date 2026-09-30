import React from 'react';
import { LED_SETS, ledGlow } from './HoldMarker.jsx';

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Deterministic unlit hold layout so every board looks bolted-up, not empty.
function holdLayout(board, rows, cols) {
  let s = 7;
  for (const ch of board + rows + 'x' + cols) s = (s * 31 + ch.charCodeAt(0)) % 233280;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const out = {};
  for (let r = 1; r <= rows; r++) for (let c = 0; c < cols; c++) {
    const a = rnd(), w = rnd(), h = rnd(), t = rnd();
    out[r + '-' + c] = a < 0.52 ? { w: 0.34 + w * 0.3, h: 0.3 + h * 0.26, t: Math.round(t * 180) } : null;
  }
  return out;
}

// holds: [{ r, c, role }] — r counts from the bottom (1-based), c is 0-based column (A = 0).
export function BoardView({ board = 'moon', rows = 18, cols = 11, holds = [], lit = true, showLabels = true, showHolds = true, cropMarks = true, onHoldClick, style }) {
  const set = LED_SETS[board] || LED_SETS.moon;
  const layout = React.useMemo(() => holdLayout(board, rows, cols), [board, rows, cols]);
  const cw = 100 / cols, rh = 100 / rows;
  const at = (r, c) => ({ left: ((c + 0.5) * cw) + '%', top: ((rows - r + 0.5) * rh) + '%' });
  const litMap = {};
  holds.forEach(h => { litMap[h.r + '-' + h.c] = h.role; });

  const dims = [];
  if (showHolds) {
    for (let r = 1; r <= rows; r++) for (let c = 0; c < cols; c++) {
      const k = r + '-' + c;
      const d = layout[k] || (litMap[k] ? { w: 0.5, h: 0.42, t: 30 } : null);
      if (!d) continue;
      dims.push(<span key={'d' + k} style={{ position: 'absolute', ...at(r, c), width: (cw * d.w) + '%', aspectRatio: d.w / d.h, borderRadius: '42%', background: 'var(--board-hold)', transform: 'translate(-50%, -50%) rotate(' + d.t + 'deg)' }} />);
    }
  }
  const rings = holds.map((h, i) => {
    const color = set[h.role] || set.hand;
    return <span key={'h' + i} style={{ position: 'absolute', ...at(h.r, h.c), width: (cw * 0.84) + '%', aspectRatio: '1 / 1', transform: 'translate(-50%, -50%)', borderRadius: '50%', border: '2px solid ' + color,
      background: 'color-mix(in srgb, ' + color + ' 16%, transparent)', boxShadow: lit ? ledGlow(color) : 'none', opacity: lit ? 1 : 0.6, transition: 'opacity var(--dur-slow), box-shadow var(--dur-slow)' }} />;
  });
  const markStyle = { position: 'absolute', width: 'var(--crop-mark)', height: 'var(--crop-mark)', borderColor: 'var(--board-label)', borderStyle: 'solid', borderWidth: 0 };
  const lab = { fontFamily: 'var(--font-mono)', fontSize: 9, lineHeight: 1, color: 'var(--board-label)' };

  const panel = (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: cols + ' / ' + rows, borderRadius: 6, overflow: 'hidden', backgroundColor: 'var(--board-panel)', boxShadow: '0 0 0 1px var(--board-panel-edge)',
        backgroundImage: 'radial-gradient(circle, var(--board-hole) 1.3px, transparent 1.8px)', backgroundSize: cw + '% ' + rh + '%' }}>
        {dims}{rings}
        {onHoldClick ? (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'repeat(' + cols + ', 1fr)', gridTemplateRows: 'repeat(' + rows + ', 1fr)' }}>
            {Array.from({ length: rows * cols }, (_, i) => {
              const r = rows - Math.floor(i / cols), c = i % cols;
              return <button key={i} type="button" aria-label={COL_LETTERS[c] + r} onClick={() => onHoldClick({ r, c, role: litMap[r + '-' + c] })} style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} />;
            })}
          </div>
        ) : null}
      </div>
      {cropMarks ? <>
        <span style={{ ...markStyle, left: -6, top: -6, borderLeftWidth: 1, borderTopWidth: 1 }} />
        <span style={{ ...markStyle, right: -6, top: -6, borderRightWidth: 1, borderTopWidth: 1 }} />
        <span style={{ ...markStyle, left: -6, bottom: -6, borderLeftWidth: 1, borderBottomWidth: 1 }} />
        <span style={{ ...markStyle, right: -6, bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 }} />
      </> : null}
    </div>
  );
  if (!showLabels) return <div style={style}>{panel}</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) 14px', columnGap: 8, rowGap: 7, ...style }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {Array.from({ length: rows }, (_, i) => <span key={i} style={{ ...lab, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{rows - i}</span>)}
      </div>
      {panel}
      <span />
      <span />
      <div style={{ display: 'flex' }}>
        {Array.from({ length: cols }, (_, c) => <span key={c} style={{ ...lab, flex: 1, textAlign: 'center' }}>{COL_LETTERS[c]}</span>)}
      </div>
      <span />
    </div>
  );
}

/** "E4 G5" style coordinates for a set of holds, grouped by role. */
export function holdCoords(holds = [], role) {
  return holds.filter(h => !role || h.role === role).map(h => COL_LETTERS[h.c] + h.r).join(' ');
}
