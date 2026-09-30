Mono readouts for numbers: `StatTile` (hairline card) for History, `ReadoutStrip` for the row of figures on problem detail.

```jsx
<StatTile label="Sends" value="48" unit="Sept" delta="+8 vs Aug" />
<ReadoutStrip items={[{ label: 'Sends', value: '241' }, { label: 'Flash', value: '28%' }, { label: 'Quality', value: '2.9' }, { label: 'Beta', value: 3 }]} />
```

- Labels are 9–10px mono uppercase; values are Geist Mono (300 in tiles, 400 in strips).
- Deltas are text arrows (↑ ↓) in muted success/danger — no pills.
- 3–4 items per strip on phone; up to 6 on desktop.
