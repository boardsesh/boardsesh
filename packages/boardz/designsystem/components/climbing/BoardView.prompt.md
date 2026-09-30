The board view: a dark LED panel with coordinates, crop marks, unlit holds and glowing lit holds. It's the hero of problem detail.

```jsx
<div style={{ width: 300 }}>
  <BoardView board="moon" rows={18} cols={11} holds={[{ r: 4, c: 4, role: 'start' }, { r: 8, c: 5, role: 'hand' }, { r: 18, c: 5, role: 'finish' }]} />
</div>
```

- Fluid width; height follows `cols:rows`. Size it with the parent (≈260–300px on phone, 380–440px on tablet/desktop).
- Hold colors come from the board's own LED set (`board` prop), never from brand colors.
- `lit={false}` dims the rings (board not connected / preview).
- Pair with `holdCoords(holds, role)` to print the coordinate legend ("E4 G5", "F8 C10 E12…").
- `onHoldClick` makes every cell tappable (setting/editing problems).
