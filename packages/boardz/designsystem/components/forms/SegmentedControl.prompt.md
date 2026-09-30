The control strip: a hairline box split into cells; the selected cell fills with ink. Single-select, or `multiple` for filter toggles.

```jsx
<SegmentedControl value={angle} onChange={setAngle} options={['25°', '40°', '50°']} />
<SegmentedControl multiple fullWidth size="lg" value={filters} onChange={setFilters}
  options={[{ value: 'bench', label: 'Benchmarks', grow: 1.4 }, { value: 'unsent', label: 'Not sent' }, { value: 'beta', label: 'Beta' }]} />
```

- Replaces chip rows on phone. Use `lg` (44px) for touch, `xl` in board mode.
- `grow` on an option widens its cell when `fullWidth`.
- Options accept `icon` (Lucide name).
