Small label for status and metadata; the mono outline tag is the house style.

```jsx
<Badge mono outline>Benchmark</Badge>
<Badge mono outline size="xs">BM</Badge>
<Badge mono outline>40°</Badge>
<Badge tone="success" dot>Sent</Badge>
<Badge tone="accent" mono>New</Badge>
```

- Prefer `mono outline` (neutral) for metadata. Tinted tones are for status only.
- `dot` on success/danger/warning/info renders a glowing LED dot, matching the connection pill.
- `xs` sits inline in problem rows; `sm` in headers; `md` standalone.
