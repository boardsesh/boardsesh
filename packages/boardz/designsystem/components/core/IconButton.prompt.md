Icon-only button for toolbars and top bars (back, favorite, filters, share).

```jsx
<IconButton icon="chevron-left" label="Back" />
<IconButton icon="heart" label="Favorite" active />
<IconButton icon="sliders-horizontal" label="Filters" variant="secondary" size="lg" />
```

- `ghost` (default) for top bars, `secondary` (hairline) next to inputs, `tonal` for quiet filled, `primary` rarely.
- `active` fills the glyph in ink. Favorites stay monochrome; no red hearts.
- `lg` = 48px, `xl` = 56px board mode. Always pass `label` (becomes aria-label + tooltip).
