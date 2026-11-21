# PR #6694 browser rendering evidence

These four browser captures compare main `e9c73ee954804b810ba43553f892743bb0e900b5` with implementation commit `5b409bd5e3` on 21 November 2026. Each image has five independent 390px columns: an active account with the logbook warning, an ordinary failed sync, and warning copy in German, Italian, and Simplified Chinese.

| Capture | Dimensions | Bytes |
| --- | --- | ---: |
| [mobile-before.png](mobile-before.png) | 2100 × 650 | 45,612 |
| [mobile-after.png](mobile-after.png) | 2100 × 650 | 85,557 |
| [web-before.png](web-before.png) | 2100 × 650 | 58,769 |
| [web-after.png](web-after.png) | 2100 × 650 | 95,952 |

The web fixture mounts the actual `BoardCredentialCard` source, CSS module, and MUI theme. The mobile fixture renders the exact private `BoardAccountCard` function and its unchanged production style object from `BoardAccountsSection.tsx` through React Native Web. The mobile text, button, status-pill, and icon leaves use explicit fixture adapters; they do not verify the app's native controls, fonts, or icon renderer. Both fixtures use local credential objects and the actual before/after settings catalogs. No account was linked, synced, unlinked, or altered for these captures.

Both phases receive the **same synthetic new logbook-warning code**. Main did not emit that code from the server. The before images therefore demonstrate the older client decoder/fallback when fed a newer payload; they are not a production before capture of the original Connected-with-empty-logbook API state.

The baseline sources/catalogs were read directly from the immutable main commit into ignored fixture files. The current sources/catalogs were copied into the same fixture. Production files were not replaced to create the baseline. Playwright Chromium captured both phases at a 2100 × 650 viewport. All twenty column measurements were 390px with no horizontal overflow, and there were no page errors.

The Linux host lacked complete Chinese fallback glyphs, so the local fixture used [Noto Sans CJK SC Regular](https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf) as its first font for both phases. This affects browser text metrics; the app's production font configuration is unchanged. The fixture font SHA-256 is `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`. The font binary and browser harness remain ignored local files.

This evidence establishes the card's warning/error branch, translated copy, and browser wrapping under the stated fixture. It does not prove physical Android/iOS appearance, backend ownership detection, or actual imports. The ordinary mobile failure retains its existing generic Error text and Connected pill; the web card retains its actual error text and Error pill.

The actual mobile app was also started with `vp run dev:mobile`, on `http://localhost:8083`; its startup confirmed this worktree's QA notes. Merely starting Metro is not device QA. Native fingerprint compatibility remains subject to the PR's current-head OTA check.
