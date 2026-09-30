Grade in mono, color-coded by difficulty band. The box shows state: a tinted outline means open, a solid fill means sent.

```jsx
<GradeBadge grade="6C+" />                  // open, band 3 (blue)
<GradeBadge grade="7A" variant="solid" />   // sent, band 4 (violet)
<GradeBadge grade="7A+" variant="display" size="lg" />  // problem detail readout
```

- 7 bands on `--grade-1…7`: ≤6A+ green · 6B teal · 6C blue · 7A violet · 7B magenta · 7C red · 8A+ ink. V grades map to the same bands.
- Light theme uses deep inks (text ≥4.5:1 on paper); dark theme uses brighter LED-like tones.
- Grade color is used only for grades (tags, readouts, grade charts). Use `gradeBand(grade)` for charts.
- `coded={false}` gives the plain ink tag.
