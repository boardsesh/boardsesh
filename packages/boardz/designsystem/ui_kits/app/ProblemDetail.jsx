function HoldLegend({ holds, board }) {
  const set = { moon: 'moon', kilter: 'kilter', tension: 'tension' }[board] || 'moon';
  const groups = ['start', 'hand', 'finish', 'foot'].map(role => [role, holds.filter(h => h.role === role).map(h => COLS[h.c] + h.r).join(' ')]).filter(g => g[1]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px 14px', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.03em', color: 'var(--fg-2)' }}>
      {groups.map(([role, txt]) => {
        const c = 'var(--led-' + set + '-' + role + ')';
        return <span key={role} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: 3, background: c, boxShadow: '0 0 6px color-mix(in srgb, ' + c + ' 80%, transparent)' }} />{txt}</span>;
      })}
    </div>
  );
}

function ProblemDetail({ ctx, p, device }) {
  const { GradeBadge, Badge, BoardView, Button, IconButton, Tabs, VideoThumb, Avatar, StatTile, ReadoutStrip, Tooltip } = window.Boardz;
  const [t, setT] = React.useState('beta');
  const D = window.BZ_DATA;
  const b = D.BOARDS[ctx.settings.board];
  const holds = D.holdsFor(p.id, b.rows, b.cols, ctx.settings.mirror);
  const phone = device === 'phone', tablet = device === 'tablet';
  const btnSize = tablet ? 'xl' : phone ? 'lg' : 'lg';
  const isLit = ctx.lit === p.id && ctx.conn === 'connected';
  const flash = Math.round(20 + (p.id * 7) % 30);
  const no = 'No. ' + String(p.id + 130).padStart(4, '0');

  const title = (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0 }}>
        <span style={{ fontSize: phone ? 30 : 36, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1 }}>{p.name}</span>
        <span style={{ fontSize: 13, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.setter} · {p.set}</span>
        {p.benchmark || p.sent ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {p.benchmark ? <Badge mono outline size="sm">Benchmark</Badge> : null}
            {p.sent ? <Badge mono outline size="sm" dot tone="success" style={{ color: 'var(--fg-2)', boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>Sent</Badge> : null}
          </div>
        ) : null}
      </div>
      <GradeBadge grade={ctx.g(p.grade)} variant="display" size={tablet ? 'xl' : 'lg'} style={{ flexShrink: 0 }} />
    </div>
  );

  const readouts = <ReadoutStrip items={[{ label: 'Sends', value: p.ascents.toLocaleString('en-US') }, { label: 'Flash', value: flash + '%' }, { label: 'Quality', value: p.quality }, { label: 'Beta', value: p.betaCount }]} />;

  const actions = (
    <div style={{ display: 'flex', gap: 8, ...(phone ? { alignItems: 'center', justifyContent: 'center' } : null) }}>
      {!phone ? (
        <Button size={btnSize} led={isLit ? undefined : true} icon={isLit ? 'lightbulb-off' : undefined} variant={isLit ? 'secondary' : 'primary'} style={{ flex: 1 }} onClick={() => ctx.lightUp(p.id)}>
          {isLit ? 'Lights off' : 'Light it up'}
        </Button>
      ) : null}
      <Button size={btnSize} icon="check" variant="secondary" style={phone ? { flex: '0 0 112px', height: 39, width: 217, textAlign: 'center' } : { flex: 1 }} onClick={ctx.openLog}>Log</Button>
      {!phone ? (
        <Tooltip label={p.favorite ? 'Unfavorite' : 'Favorite'}>
          <IconButton icon="heart" label="Favorite" variant="secondary" size={btnSize} active={p.favorite} onClick={() => ctx.toggleFav(p.id)} />
        </Tooltip>
      ) : null}
    </div>
  );

  const betas = D.betas.slice(0, p.betaCount);
  const tabs = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Tabs value={t} onChange={setT} items={[{ value: 'beta', label: 'Beta', count: p.betaCount }, { value: 'ascents', label: 'Ascents', count: p.ascents.toLocaleString('en-US') }, { value: 'info', label: 'Info' }]} />
      {t === 'beta' ? (betas.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 10 }}>
          {betas.slice(0, 3).map((v, i) => <VideoThumb key={i} {...v} aspect="4 / 5" title={phone ? undefined : v.title} onClick={() => ctx.toast({ tone: 'info', title: 'Playing beta', message: v.author })} />)}
        </div>
      ) : (
        <div style={{ padding: '28px 16px', textAlign: 'center', borderRadius: 'var(--radius-lg)', boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em' }}>No beta yet.</div>
          <div style={{ fontSize: 14, color: 'var(--fg-3)', margin: '2px 0 14px' }}>Be the first to film it.</div>
          <Button variant="secondary" size="sm" icon="upload">Upload beta</Button>
        </div>
      )) : null}
      {t === 'ascents' ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {D.ascents.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: i < D.ascents.length - 1 ? '1px solid var(--border-1)' : 0 }}>
              <Avatar name={a.name} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</span>
                  <span style={{ ...monoLabel, color: a.result === 'Flashed' ? 'var(--fg-1)' : 'var(--fg-3)' }}>{a.result}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{a.when}</span>
                </div>
                {a.comment ? <div style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 3 }}>{a.comment}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {t === 'info' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <StatTile label="Consensus" value={ctx.g(p.grade)} unit="spot on" />
          <StatTile label="Set" value={p.set.split(' ')[1]} unit={p.set.split(' ')[0]} />
          <StatTile label="Angle" value={ctx.settings.angle} />
          <StatTile label="Holds" value={holds.length} unit={holds.filter(h => h.role === 'hand').length + ' hands'} />
        </div>
      ) : null}
    </div>
  );

  const board = <BoardView board={ctx.settings.board} rows={b.rows} cols={b.cols} holds={holds} lit={isLit || ctx.conn !== 'connected'} />;

  if (phone) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 8px' }}>
          <IconButton icon="chevron-left" label="Back" size="lg" onClick={ctx.close} />
          <Label style={{ flex: 1, textAlign: 'center' }}>{no} · {b.label}</Label>
          <IconButton icon="heart" label="Favorite" size="lg" active={p.favorite} onClick={() => ctx.toggleFav(p.id)} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '6px 20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {title}
          <div style={{ width: '100%', maxWidth: 292, alignSelf: 'center', marginTop: 4 }}>{board}</div>
          <HoldLegend holds={holds} board={ctx.settings.board} />
          {readouts}
          {tabs}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-2)', background: 'var(--bg-app)', flexShrink: 0 }}>{actions}</div>
      </div>
    );
  }
  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: (tablet ? 'minmax(0, 330px)' : 'minmax(0, 360px)') + ' minmax(0, 1fr)', gap: tablet ? 28 : 40, padding: tablet ? '28px 28px 28px 20px' : '36px 40px', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 0 }}>
          <Label style={{ textAlign: 'center' }}>{no} · {b.label} · {ctx.settings.angle}</Label>
          {board}
          <HoldLegend holds={holds} board={ctx.settings.board} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0, paddingTop: 26 }}>
          {title}
          {readouts}
          {actions}
          {ctx.conn !== 'connected' ? <div style={{ fontSize: 13, color: 'var(--fg-3)', marginTop: -12 }}>Connect your board to light it up.</div> : null}
          {tabs}
        </div>
      </div>
    </div>
  );
}

function LogSheet({ ctx, p, phone }) {
  const { Sheet, SegmentedControl, Stepper, StarRating, TextField, Button, GradeBadge } = window.Boardz;
  const [res, setRes] = React.useState('flash');
  const [tries, setTries] = React.useState(1);
  const [feel, setFeel] = React.useState('on');
  const [stars, setStars] = React.useState(0);
  const [note, setNote] = React.useState('');
  React.useEffect(() => { if (ctx.logOpen) { setRes('flash'); setTries(1); setStars(0); setNote(''); setFeel('on'); } }, [ctx.logOpen]);
  if (!p) return null;
  return (
    <Sheet contained open={ctx.logOpen} onClose={ctx.closeLog} title="Log it" variant={phone ? 'bottom' : 'dialog'} width={440}
      footer={<Button fullWidth size="lg" icon="check" onClick={() => ctx.logAscent(p.id, res, tries)}>{res === 'attempt' ? 'Save attempts' : res === 'flash' ? 'Save flash' : 'Save send'}</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 14, borderBottom: '1px solid var(--border-2)' }}>
          <GradeBadge grade={ctx.g(p.grade)} variant={p.sent ? 'solid' : 'outline'} />
          <span style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.015em', flex: 1 }}>{p.name}</span>
          <Label>{ctx.settings.angle}</Label>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Label>How did it go?</Label>
          <SegmentedControl fullWidth size="lg" value={res} onChange={v => { setRes(v); if (v === 'flash') setTries(1); else if (tries < 2) setTries(2); }}
            options={[{ value: 'flash', label: 'Flash', icon: 'zap' }, { value: 'send', label: 'Sent', icon: 'check' }, { value: 'attempt', label: 'Working it', icon: 'rotate-ccw', grow: 1.3 }]} />
        </div>
        {res !== 'flash' ? <Stepper label="Attempts" value={tries} onChange={setTries} min={res === 'send' ? 2 : 1} /> : null}
        {res !== 'attempt' ? <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Label>Grade feels</Label><SegmentedControl fullWidth size="lg" value={feel} onChange={setFeel} options={[{ value: 'soft', label: 'Soft' }, { value: 'on', label: 'Spot on' }, { value: 'hard', label: 'Sandbagged', grow: 1.3 }]} /></div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 15 }}>Quality</span><StarRating value={stars} onChange={setStars} size={24} /></div>
        </> : null}
        <TextField label="Notes" multiline rows={2} placeholder="Beta, a victory yell, anything" value={note} onChange={setNote} />
      </div>
    </Sheet>
  );
}

Object.assign(window, { HoldLegend, ProblemDetail, LogSheet });
