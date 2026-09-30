Modal surface: bottom sheet on phone, dialog on tablet/desktop, side panel for filters.

```jsx
<Sheet open title="Log ascent" variant="bottom" onClose={close} footer={<Button fullWidth>Save</Button>}>…</Sheet>
```

contained positions absolutely inside the nearest positioned parent (device frames).
