# Busy times browser examples

These are actual Chromium captures of the Expo Web Busy times component in a vertical FlashList header, using synthetic gym data at a 390 × 844 viewport. They do not show a physical phone or an authenticated production gym.

The before capture uses the landed card from `c7cda5ca5e5eed4d29302881b24292b475546ce7`. The after captures use the reviewed implementation at `864cc2ed5877c234d3f29f4fc69a68298d0635ce`. The initial before and after images are identical: the improvement is bounded rendering, from 168 hourly controls to 77–84 in the measured scrolling states.

- [Before](before.png) and [after](after.png): identical initial appearance.
- [Late hour](late-hour.png): selected Sunday 11 PM; detail continues below the viewport.
- [German, light appearance](german-light.png): 140% browser zoom and aligned rows.

The browser proof checked keyboard access, retained selection and focus during recycling. Native swipes, Dynamic Type and screen-reader output still require device QA.

Files are unedited copies of the recorded browser output.

| File | Original capture | SHA-256 |
| --- | --- | --- |
| `before.png` | `baseline-control-dark-start.png` | `cb253ae68c0c04fb8d2a5aa9da2a447cb5fbfb7123fa0e2c96a293ca27899e1b` |
| `after.png` | `fixed-dark-start.png` | `cb253ae68c0c04fb8d2a5aa9da2a447cb5fbfb7123fa0e2c96a293ca27899e1b` |
| `late-hour.png` | `fixed-dark-end.png` | `6bba62e3a5810c527b47b6f3a2e871a3c9c8ec85ef225e219304d5ea105c6011` |
| `german-light.png` | `fixed-light-zoom.png` | `de9a6e32a23ee391f8dbc4ff7596c5580de3c61991a104d4c0581bbfc3350529` |
