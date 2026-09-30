function applyFilters(problems, f, q) {
  const G = window.BZ_DATA.GRADES;
  const out = problems.filter(p => {
    const gi = G.indexOf(p.grade);
    if (gi < G.indexOf(f.min) || gi > G.indexOf(f.max)) return false;
    if (f.bench && !p.benchmark) return false;
    if (f.unsent && p.sent) return false;
    if (f.fav && !p.favorite) return false;
    if (f.beta && !p.betaCount) return false;
    if (q && !(p.name + ' ' + p.setter).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const by = { popular: (a, b) => b.ascents - a.ascents, grade: (a, b) => G.indexOf(a.grade) - G.indexOf(b.grade), stars: (a, b) => b.quality - a.quality || b.ascents - a.ascents, newest: (a, b) => b.id - a.id };
  return out.slice().sort(by[f.sort] || by.popular);
}
const SORTS = [['popular', 'Most sent'], ['newest', 'Newest'], ['grade', 'Easiest'], ['stars', 'Top rated']];

function ProblemList({ ctx, pad = 20 }) {
  const { TextField, IconButton, SegmentedControl, ProblemRow, Icon } = window.Boardz;
  const [q, setQ] = React.useState('');
  const f = ctx.filters;
  const list = applyFilters(ctx.problems, f, q);
  const ranged = f.min !== '6A' || f.max !== '8B';
  const toggles = ['range', 'bench', 'unsent', 'beta'].filter(k => k === 'range' ? ranged : f[k]);
  const onStrip = v => {
    if (v.includes('range') !== ranged) { ctx.openFilters(); return; }
    ctx.setFilters({ ...f, bench: v.includes('bench'), unsent: v.includes('unsent'), beta: v.includes('beta') });
  };
  const si = SORTS.findIndex(s => s[0] === f.sort);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 ' + pad + 'px' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextField icon="search" placeholder="Search problems or setters" clearable value={q} onChange={setQ} style={{ flex: 1 }} />
          <IconButton icon="sliders-horizontal" label="All filters" variant="secondary" size="lg" style={{ width: 44, height: 44 }} onClick={ctx.openFilters} />
        </div>
        <SegmentedControl multiple fullWidth size="lg" value={toggles} onChange={onStrip}
          options={[{ value: 'range', label: ctx.g(f.min) + ' – ' + ctx.g(f.max), iconRight: 'chevron-down', grow: 1.25 }, { value: 'bench', label: 'Benchmarks', grow: 1.4 }, { value: 'unsent', label: 'Not sent', grow: 1.1 }, { value: 'beta', label: 'Beta', grow: 0.8 }]} />
      </div>
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, padding: '0 ' + pad + 'px', height: 30, borderBottom: '1px solid var(--border-2)', flexShrink: 0 }}>
        <Label style={{ width: 24 }}>No.</Label>
        <Label style={{ flex: 1 }}>Problem · {list.length}</Label>
        <button type="button" onClick={() => ctx.setFilters({ ...f, sort: SORTS[(si + 1) % SORTS.length][0] })}
          style={{ ...monoLabel, color: 'var(--fg-2)', border: 0, background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, height: 30, padding: 0 }}>
          {SORTS[si][1]}<Icon name="arrow-down" size={11} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, scrollbarWidth: 'none' }}>
        {list.map((p, i) => (
          <ProblemRow key={p.id} index={i + 1} problem={{ ...p, grade: ctx.g(p.grade), ascents: p.ascents.toLocaleString('en-US') }} selected={ctx.split && ctx.selId === p.id}
            onClick={() => ctx.open(p.id)} style={{ padding: '0 ' + pad + 'px' }} />
        ))}
        {list.length === 0 ? (
          <div style={{ padding: '56px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em' }}>Nothing here. Too spicy?</div>
            <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>Loosen a filter or two.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FiltersSheet({ ctx, phone }) {
  const { Sheet, Select, SegmentedControl, Checkbox, Button } = window.Boardz;
  const [f, setF] = React.useState(ctx.filters);
  React.useEffect(() => { if (ctx.filtersOpen) setF(ctx.filters); }, [ctx.filtersOpen]);
  const set = (k, v) => setF({ ...f, [k]: v });
  const n = applyFilters(ctx.problems, f, '').length;
  const opts = window.BZ_DATA.GRADES.map(g => ({ value: g, label: ctx.g(g) }));
  const reset = { min: '6A', max: '8B', bench: false, unsent: false, fav: false, beta: false, sort: 'popular' };
  return (
    <Sheet contained open={ctx.filtersOpen} onClose={ctx.closeFilters} title="Filters" variant={phone ? 'bottom' : 'dialog'} width={420}
      footer={<>
        <Button variant="ghost" size="lg" onClick={() => setF(reset)}>Reset</Button>
        <Button fullWidth size="lg" onClick={() => { ctx.setFilters(f); ctx.closeFilters(); }}>Show {n} problems</Button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select label="From" value={f.min} onChange={v => set('min', v)} options={opts} />
          <Select label="To" value={f.max} onChange={v => set('max', v)} options={opts} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Label>Sort by</Label>
          <SegmentedControl fullWidth size="lg" value={f.sort} onChange={v => set('sort', v)} options={SORTS.map(([value, label]) => ({ value, label: label.replace('Most sent', 'Sends').replace('Top rated', 'Stars') }))} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Checkbox checked={f.bench} onChange={v => set('bench', v)} label="Benchmarks only" description="The board's official graded set" />
          <Checkbox checked={f.unsent} onChange={v => set('unsent', v)} label="Hide what I've sent" />
          <Checkbox checked={f.fav} onChange={v => set('fav', v)} label="Favorites only" />
          <Checkbox checked={f.beta} onChange={v => set('beta', v)} label="Has beta video" />
        </div>
      </div>
    </Sheet>
  );
}

Object.assign(window, { applyFilters, SORTS, ProblemList, FiltersSheet });
