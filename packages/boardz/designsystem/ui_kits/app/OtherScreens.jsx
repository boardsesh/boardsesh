function RankingsScreen({ ctx, pad }) {
  const { Tabs, Avatar, Badge } = window.Boardz;
  const [t, setT] = React.useState('month');
  const b = window.BZ_DATA.BOARDS[ctx.settings.board];
  const mult = t === 'week' ? 0.2 : t === 'all' ? 6.4 : 1;
  return (
    <div style={{ padding: '0 ' + pad + 'px ' + pad + 'px', maxWidth: 760 }}>
      <Tabs value={t} onChange={setT} items={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }]} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 34, borderBottom: '1px solid var(--border-2)' }}>
        <Label style={{ width: 24 }}>No.</Label><Label style={{ flex: 1 }}>Climber · {b.label}</Label><Label>Points</Label>
      </div>
      {window.BZ_DATA.climbers.map(c => (
        <div key={c.rank} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 62, padding: c.you ? '0 12px' : 0, margin: c.you ? '0 -12px' : 0, borderBottom: '1px solid var(--border-1)', background: c.you ? 'var(--bg-surface-3)' : 'transparent', borderRadius: c.you ? 'var(--radius-md)' : 0 }}>
          <span style={{ width: 24, fontFamily: 'var(--font-mono)', fontSize: 12, color: c.rank <= 3 ? 'var(--fg-1)' : 'var(--fg-3)' }}>{String(c.rank).padStart(2, '0')}</span>
          <Avatar name={c.name === 'You' ? 'David R' : c.name} size={34} ring={c.you ? 'var(--fg-1)' : undefined} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 8 }}>{c.name}{c.you ? <Badge mono outline size="xs">You</Badge> : null}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{Math.round(c.sends * mult)} sends · top {ctx.g(c.top)}</span>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: c.rank === 1 ? 500 : 400, letterSpacing: '-0.02em' }}>{Math.round(c.points * mult).toLocaleString('en-US')}</span>
        </div>
      ))}
    </div>
  );
}

function ListsScreen({ ctx, pad, device }) {
  const { Card, Icon, ProblemRow, Button, GradeBadge } = window.Boardz;
  const D = window.BZ_DATA;
  const [sel, setSel] = React.useState('fav');
  const list = D.lists.find(l => l.id === sel);
  const items = list.ids.map(id => ctx.problems.find(p => p.id === id));
  return (
    <div style={{ padding: '0 ' + pad + 'px ' + pad + 'px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'grid', gridTemplateColumns: device === 'phone' ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        {D.lists.map(l => (
          <Card key={l.id} interactive selected={l.id === sel} padding={14} onClick={() => setSel(l.id)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={l.icon} size={16} /></span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{String(l.ids.length).padStart(2, '0')}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em' }}>{l.name}</span>
              <div style={{ display: 'flex', gap: 4 }}>{l.ids.slice(0, 3).map(id => <GradeBadge key={id} size="sm" grade={ctx.g(D.problems[id - 1].grade)} style={{ minWidth: 34, height: 22, fontSize: 10 }} />)}</div>
            </div>
          </Card>
        ))}
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.03em' }}>{list.name}</span>
          <Button size="sm" variant="secondary" icon="plus">New list</Button>
        </div>
        <div style={{ margin: '0 -' + pad + 'px', borderTop: '1px solid var(--border-2)' }}>
          {items.map((p, i) => <ProblemRow key={p.id} index={i + 1} problem={{ ...p, grade: ctx.g(p.grade), ascents: p.ascents.toLocaleString('en-US') }} onClick={() => ctx.open(p.id, true)} onFavorite={() => ctx.toggleFav(p.id)} style={{ padding: '0 ' + pad + 'px' }} />)}
        </div>
      </div>
    </div>
  );
}

function HistoryScreen({ ctx, pad, device }) {
  const { StatTile, GradeBadge, gradeBand } = window.Boardz;
  const D = window.BZ_DATA;
  const phone = device === 'phone';
  const maxW = Math.max(...D.weekly);
  const maxP = Math.max(...D.pyramid.map(x => x[1]));
  return (
    <div style={{ padding: '0 ' + pad + 'px ' + pad + 'px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr 1fr' : 'repeat(4, minmax(0,1fr))', gap: 10 }}>
        <StatTile label="Sends · Sept" value={ctx.sentCount + 37} delta="+8 vs Aug" />
        <StatTile label="Top grade" value={ctx.g('7A+')} />
        <StatTile label="Sessions" value="11" unit="this month" />
        <StatTile label="Flash rate" value="34%" delta="-3%" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'minmax(0,1.3fr) minmax(0,1fr)', gap: 12 }}>
        <Section title="Sends per week">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120, borderBottom: '1px solid var(--border-2)' }}>
            {D.weekly.map((w, i) => <div key={i} style={{ flex: 1, height: (w / maxW * 100) + '%', borderRadius: '3px 3px 0 0', background: i === D.weekly.length - 1 ? 'var(--fg-1)' : 'var(--border-2)' }} />)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><Label>Jul</Label><Label>Aug</Label><Label>Sep</Label></div>
        </Section>
        <Section title="Grade pyramid">
          <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 5 }}>
            {D.pyramid.map(([g, n]) => (
              <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 32, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)' }}>{ctx.g(g)}</span>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><div style={{ width: (n / maxP * 100) + '%', height: 9, borderRadius: 2, background: 'var(--grade-' + gradeBand(g) + ')' }} /></div>
                <span style={{ width: 20, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{n}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <Section title="Logbook">
        {D.logbook.map(day => (
          <div key={day.date} style={{ display: 'flex', flexDirection: 'column' }}>
            <Label style={{ padding: '6px 0 8px', color: 'var(--fg-2)' }}>{day.date}</Label>
            {day.items.map(([id, r], i) => {
              const p = D.problems[id - 1];
              return (
                <div key={i} onClick={() => ctx.open(id, true)} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, cursor: 'pointer', borderTop: '1px solid var(--border-1)' }}>
                  <GradeBadge grade={ctx.g(p.grade)} size="sm" variant={r.startsWith('Attempts') ? 'outline' : 'solid'} />
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em' }}>{p.name}</span>
                  <span style={{ ...monoLabel, color: r === 'Flash' ? 'var(--fg-1)' : 'var(--fg-3)' }}>{r}</span>
                </div>
              );
            })}
          </div>
        ))}
      </Section>
    </div>
  );
}

function SettingsScreen({ ctx, pad }) {
  const { Select, SegmentedControl, Switch, Radio, Button } = window.Boardz;
  const s = ctx.settings;
  const set = (k, v) => ctx.setSettings({ ...s, [k]: v });
  return (
    <div style={{ padding: '0 ' + pad + 'px ' + pad + 'px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
      <Section title="Board">
        <Select label="Board type" value={s.board} onChange={v => set('board', v)} options={Object.entries(window.BZ_DATA.BOARDS).map(([k, b]) => ({ value: k, label: b.label }))} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Label>Wall angle</Label>
          <SegmentedControl fullWidth size="lg" value={s.angle} onChange={v => set('angle', v)} options={['25°', '40°', '50°']} /></div>
        <Switch label="Auto-light on open" description="Lights the problem as soon as you open it" checked={s.autoLight} onChange={v => set('autoLight', v)} />
        <Switch label="Mirror problems" description="Flip left and right, for the lefties" checked={s.mirror} onChange={v => set('mirror', v)} />
      </Section>
      <Section title="Display">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Label>Theme</Label>
          <SegmentedControl fullWidth size="lg" value={ctx.theme} onChange={ctx.setTheme} options={[{ value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }]} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Label>Grades</Label>
          <Radio name="grades" value="font" checked={s.grades === 'font'} onChange={v => set('grades', v)} label="Font (6A, 7B+)" />
          <Radio name="grades" value="v" checked={s.grades === 'v'} onChange={v => set('grades', v)} label="V-scale (V3, V8)" />
        </div>
      </Section>
      <Section title="Session">
        <Switch label="Keep screen awake" checked={s.awake} onChange={v => set('awake', v)} />
        <Button variant="danger" icon="log-out" style={{ alignSelf: 'flex-start' }}>Sign out</Button>
      </Section>
    </div>
  );
}

function ConnectSheet({ ctx, phone }) {
  const { Sheet, Button, Icon } = window.Boardz;
  const [scan, setScan] = React.useState(true);
  const [busy, setBusy] = React.useState(null);
  React.useEffect(() => {
    if (!ctx.connectOpen) return;
    setScan(true); setBusy(null);
    const t = setTimeout(() => setScan(false), 1100);
    return () => clearTimeout(t);
  }, [ctx.connectOpen]);
  const connect = d => { setBusy(d.id); setTimeout(() => { ctx.connectTo(d); setBusy(null); }, 1100); };
  return (
    <Sheet contained open={ctx.connectOpen} onClose={ctx.closeConnect} title={ctx.conn === 'connected' ? 'Your board' : 'Connect a board'} variant={phone ? 'bottom' : 'dialog'} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 8 }}>
        <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>{ctx.conn === 'connected' ? 'Connected and ready to light.' : 'Switch the board on and stand close. Bluetooth does the rest.'}</div>
        <div style={{ borderTop: '1px solid var(--border-2)' }}>
          {scan ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 64, borderBottom: '1px solid var(--border-1)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--led-blue)', color: 'var(--led-blue)', animation: 'bz-pulse 1.4s var(--ease-out) infinite' }} />
              <Label style={{ color: 'var(--fg-2)' }}>Looking for boards nearby</Label>
            </div>
          ) : window.BZ_DATA.devices.map(d => {
            const mine = ctx.conn === 'connected' && ctx.settings.board === d.type;
            return (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 64, borderBottom: '1px solid var(--border-1)' }}>
                <Icon name={mine ? 'bluetooth-connected' : 'bluetooth'} size={20} color={mine ? 'var(--fg-1)' : 'var(--fg-3)'} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em' }}>{d.name}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.04em', color: 'var(--fg-3)' }}>{d.id} · SIGNAL {d.rssi.toUpperCase()}</span>
                </div>
                {mine ? <Button size="sm" variant="secondary" onClick={ctx.disconnect}>Disconnect</Button>
                  : <Button size="sm" variant={d.rssi === 'Weak' ? 'secondary' : 'primary'} loading={busy === d.id} disabled={!!busy && busy !== d.id} onClick={() => connect(d)}>{busy === d.id ? 'Pairing' : 'Connect'}</Button>}
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}

Object.assign(window, { RankingsScreen, ListsScreen, HistoryScreen, SettingsScreen, ConnectSheet });
