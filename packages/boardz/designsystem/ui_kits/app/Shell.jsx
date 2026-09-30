const NAV = [
  { value: 'problems', label: 'Problems', icon: 'layout-grid' },
  { value: 'lists', label: 'Lists', icon: 'bookmark' },
  { value: 'rankings', label: 'Rankings', icon: 'trophy' },
  { value: 'history', label: 'History', icon: 'history' },
  { value: 'settings', label: 'Settings', icon: 'settings' },
];
const COLS = 'ABCDEFGHIJKLMNOP';
const monoLabel = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--fg-3)', lineHeight: 1 };

function Label({ children, style }) {
  return <span style={{ ...monoLabel, ...style }}>{children}</span>;
}

function Wordmark({ size = 22 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: size * 0.14 }}>
      <span style={{ fontWeight: 600, fontSize: size, letterSpacing: '-0.06em', lineHeight: 1 }}>boardz</span>
      <span style={{ width: size * 0.2, height: size * 0.2, borderRadius: '50%', background: 'var(--led-blue)', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--led-blue) 60%, transparent)', marginBottom: size * 0.1 }} />
    </span>
  );
}

function StatusBar() {
  const { Icon } = window.Boardz;
  return (
    <div style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 28px 0 38px' }}>
      <span style={{ fontSize: 16, fontWeight: 600 }}>9:41</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="signal" size={16} /><Icon name="wifi" size={16} /><Icon name="battery-full" size={24} /></span>
    </div>
  );
}

// Big-title header: mono meta row + title with a mono count.
function PageHeader({ title, meta, count, right, pad = 20 }) {
  return (
    <div style={{ padding: '8px ' + pad + 'px 14px', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: -8 }}>
        <Label>{meta}</Label>{right}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 38, fontWeight: 600, letterSpacing: 'var(--tracking-display)', lineHeight: 1 }}>{title}</span>
        {count != null ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>{count}</span> : null}
      </div>
    </div>
  );
}

function Section({ title, right, children, pad = 16, style }) {
  const { Card } = window.Boardz;
  return (
    <Card padding={pad} style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, ...style }}>
      {title ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 16 }}><Label>{title}</Label>{right}</div> : null}
      {children}
    </Card>
  );
}

function Sidebar({ ctx }) {
  const { NavItem, ConnectionPill, Button } = window.Boardz;
  const b = window.BZ_DATA.BOARDS[ctx.settings.board];
  return (
    <aside style={{ width: 'var(--sidebar-w)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: '24px 12px 16px', background: 'var(--bg-app)', borderRight: '1px solid var(--border-2)' }}>
      <div style={{ padding: '0 12px 26px' }}><Wordmark /></div>
      {NAV.map(n => <NavItem key={n.value} icon={n.icon} label={n.label} count={n.value === 'lists' ? window.BZ_DATA.lists.length : undefined} active={ctx.tab === n.value} onClick={() => ctx.setTab(n.value)} />)}
      <div style={{ flex: 1 }} />
      <div style={{ margin: '0 4px', padding: '14px 0 2px', borderTop: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Label>Board</Label>
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em' }}>{b.label}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', marginTop: 3 }}>{ctx.settings.angle} · {b.cols}×{b.rows}</div>
        </div>
        {ctx.conn === 'connected'
          ? <ConnectionPill status="connected" onClick={ctx.openConnect} style={{ alignSelf: 'flex-start', marginLeft: -2 }} />
          : <Button size="sm" variant="secondary" icon="bluetooth" onClick={ctx.openConnect} style={{ alignSelf: 'flex-start' }}>Connect board</Button>}
      </div>
    </aside>
  );
}

function Rail({ ctx }) {
  const { NavItem, ConnectionPill } = window.Boardz;
  return (
    <aside style={{ width: 'var(--rail-w)', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '18px 8px 12px', background: 'var(--bg-app)', borderRight: '1px solid var(--border-2)' }}>
      <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', gap: 3, marginBottom: 14 }}>
        <span style={{ fontWeight: 600, fontSize: 22, letterSpacing: '-0.06em', lineHeight: 1 }}>bz</span>
        <span style={{ width: 5, height: 5, borderRadius: 3, marginBottom: 3, background: 'var(--led-blue)', boxShadow: '0 0 6px 1px color-mix(in srgb, var(--led-blue) 60%, transparent)' }} />
      </div>
      {NAV.map(n => <NavItem key={n.value} collapsed icon={n.icon} label={n.label} active={ctx.tab === n.value} onClick={() => ctx.setTab(n.value)} />)}
      <div style={{ flex: 1 }} />
      <ConnectionPill compact status={ctx.conn} onClick={ctx.openConnect} />
    </aside>
  );
}

Object.assign(window, { NAV, COLS, monoLabel, Label, Wordmark, StatusBar, PageHeader, Section, Sidebar, Rail });
