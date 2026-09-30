Buttons for every action; primary is solid ink, and the board-lighting action uses `led`.

```jsx
<Button led size="lg">Light it up</Button>
<Button variant="secondary" icon="check">Log</Button>
<Button variant="tonal" size="sm" icon="plus">New list</Button>
<Button variant="ghost">Skip</Button>
<Button variant="danger" size="sm">Delete</Button>
```

- One `primary` per view. `secondary` is a hairline outline; `tonal` is a quiet filled step.
- `led` (true or a color) replaces the icon with a glowing dot — reserve it for "Light it up".
- `xl` (56px) is board mode: tablet mounted at the wall, chalky fingers.
- `loading` swaps the icon for a spinner and disables the button.
