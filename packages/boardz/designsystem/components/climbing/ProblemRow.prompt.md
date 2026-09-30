Problem list row in the Graphite table style. Put rows edge to edge under a mono column header.

```jsx
<ProblemRow index={1} problem={{ name: 'Crimp Lord', grade: '6C+', setter: 'Ben Moon', ascents: '1,204', quality: 2.9, benchmark: true, sent: true }} onClick={open} />
```

- Rows are 62px, full-bleed, hairline between. Pad the list container 0; rows carry 20px side padding.
- Pair with a header row: `NO. · PROBLEM · MOST SENT ↓` in 10px mono uppercase.
- `onFavorite` adds a monochrome heart before the grade (lists screen).
- `selected` = list/detail split on tablet and desktop.
