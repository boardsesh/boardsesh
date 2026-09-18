# Marketing refresh — follow-up brief

Hand-off for finishing the dark-only marketing overhaul. The mockups in this
directory are the approved design; most of them shipped. This records what is
left, what is deliberately different, and the traps that cost time.

Read the four mockups first — each has a numbered **Design notes** section at the
bottom binding every decision to a file, test or epic:

| Mockup | Covers |
| --- | --- |
| `page-shell.html` | the shared page frame spec |
| `support.html` | `/support` |
| `homepage.html` | `/` |
| `gyms-directory.html` | `/gyms*` and `/gym/[slug]` |

---

## Where it stands

**Merged:** #5549 #5550 #5552 #5553 #5557 #5559 #5560 #5561 #5563 — the dark-only
theme collapse, the shared page shell, the `/support` redesign, the CTA
consolidation, the homepage decomposition and restyle, and the gyms restyle.

**Open, stacked — merge in this order:**

1. **#5570** — `feat/web-home-gym-search` · the "Find a board near you" block
2. **#5571** — `feat/web-home-sections` · the feature strip + support block
3. **#5572** — `feat/web-home-mockup` · wires all three into `page.tsx`, plus the
   store-first hero and the desktop both-stores fix. Merges 1 and 2 in, so its
   diff shrinks to just the wiring once they land.

All three are drafts and mergeable. **A red `ota-check` on these is almost
certainly not a failure** — GitHub cancels it when a newer run enters its
concurrency group. Check `gh api repos/boardsesh/boardsesh/actions/jobs/<id> --jq
.conclusion`; `cancelled` means ignore it.

---

## What is left

Grouped by surface. Sizes are honest estimates, not encouragement.

### 1. The hero glow — both pages · trivial · highest ratio of effect to effort

`support.html` and `homepage.html` both put a violet radial gradient behind the
hero (`.hero::before`, a 1100px `radial-gradient`). Neither shipped. The support
mockup's own note says it is "a CSS `radial-gradient`, not an asset, so it costs
nothing to ship" — and it is the single thing that most changes how the page
feels. Add it to `support.module.css` and the homepage hero.

### 2. The brand mark above the `/support` `<h1>` · trivial

The mockup has the mark; the shipped page goes straight to the heading. Note the
pinned constraint before adding it: `support-content.test.tsx:89-95` asserts the
page has exactly one `<h1>` whose `textContent` equals `support.hero.title`, so
the mark must sit **outside** the heading, not inside it.

### 3. The "Shared queue" screenshot · moderate — needs a capture, not code

`home-feature-strip.tsx` renders a marked placeholder for that column because
none of the eight committed Play Store captures in
`app-stores/google/screenshots/pixel-2/` shows the queue sheet. The other two
columns use real captures. **Do not substitute a different screenshot** — the
placeholder is honest, a misleading image is not. Capture the queue sheet
(`vp run mobile:ios-shots` or `mobile:android-shots`), crop to the device frame
to match the existing 738×1312 WebPs, and drop it in.

### 4. Gyms directory finish · moderate

From `gyms-directory.html`, deliberately scoped out of #5563:

- **Claimed / Unclaimed badge** on directory cards. Not done because
  `GymDirectoryCard` has no badge and adding one meant forking the shared card.
  Decide whether the badge belongs on the shared card or a homepage-only variant.
- **"Location off? Type a town instead"** hint under the search form.
- **A dark map tile source.** This is the blocker behind the marker styling:
  `gym-directory-map.tsx` keeps its marker rings *light* on purpose, because OSM's
  standard raster tiles are a light basemap and a dark ring on light streets is
  worse than what ships today. Retuning the markers is the day the tiles go dark.
  That is a tile-provider decision, not a CSS one.

### 5. Homepage gym teaser ordering · needs a decision

`home-gym-search.tsx` fills its four cards from the directory's default first
page, which does not down-rank sparse or unclaimed listings. `gyms-directory.html`
note 5 leaves the ordering open. Decide whether claimed gyms should surface first.

### 6. Board-art double fetch · tracked separately

Issue **#5558**. Both light and dark board art are still fetched on every board
surface. Deferred on purpose: the `<link rel="preload">` sites (`app/page.tsx`,
`app/playlists/page.tsx`, the board list and view pages) still name the *light*
file, so a half-done collapse is an LCP regression rather than a win. Change the
preloads in the same PR.

---

## Deliberate differences from the mockups — do not "fix" these

- **Hero store buttons.** The mockup draws two store badges side by side.
  Shipped: one platform-aware button on a phone, **both** on desktop. An Android
  visitor should not be offered the App Store, and the button self-suppresses
  inside the native app. iPadOS 13+ reports a Macintosh UA, so the classifier in
  `use-install-platform.ts` separates a real Mac from an iPad on `maxTouchPoints`.
  A test in `hero-install.test.ts` pins that nothing but desktop returns two.
- **Gym detail page width.** The mockup says `width="prose"`; it ships `wide`
  with per-block `maxWidth: '68ch'` caps. That page has both long-form copy and
  card grids — a blanket `prose` would crush the grids.
- **The onboarding card stack survives.** The mockup's IA drops it, but
  `home-page-content.test.tsx` pins the exact hrefs of the gym, Aurora-migration,
  playlist and Bluetooth cards, and they are real crawlable internal links.

---

## Traps that cost time this session

- **`vp check` is not clean on `main`.** Two pre-existing
  `@gorhom/bottom-sheet` module-resolution errors in `packages/mobile`. Expect
  them; do not chase them.
- **`vp run test:e2e` is not clean on `main` either.** Four pre-existing failures
  — kiosk/embed WebSocket counts in `site-chrome.spec.ts`, `embed-headers.spec.ts`,
  and the expo-web boot. Verified identical on a clean `main`. The assertions that
  actually gate a page-frame change (header/footer testids, the four nav anchors
  on `/about`, `scrollHeight − footerBottom < 24`) are in the 106 that pass.
- **Commit scope must come from the allowed list** in
  `scripts/check-commit-message.ts`. `design` is not on it; `web` is. It checks
  the PR title too.
- **`check:i18n:orphans` is two-way.** Deleting a string's last reference orphans
  its key and fails CI. Delete the key from all four locales in the same commit.
- **`t(variable)` and `t('a' + b)` hard-fail the linter.** Write keys longhand,
  however repetitive.
- **An async RSC cannot be imported by a client component.** `home-page-content.tsx`
  is `'use client'` because the hero reads the visitor's platform, so the three
  marketing sections render in `page.tsx` and arrive as `ReactNode` slots. Keep
  that shape — it is what keeps their markup server-rendered for crawlers.
- **`git fetch origin` may die on the SSH agent.** Use
  `git fetch https://github.com/boardsesh/boardsesh.git main`.
- **The shared Tailscale dev Postgres was stuck** on `0226_spray_wall_tables`:
  applied in full, but its `drizzle.__drizzle_migrations` row missing, so every
  run re-attempted it and died on `CREATE TYPE`. The fix is to record it, not to
  drop and re-run. A local `docker compose up -d` gives you your own DB instead.

---

## Verify

```
vp run typecheck:web
vp test run --project web --reporter=agent
vp test run --project i18n --reporter=agent
vp run check:i18n
vp run check:i18n:orphans
vp check
```

Then render it. `vp run dev` (or `vp run dev:web` with a local DB) and walk `/`,
`/support`, `/gyms/kilter`, `/about`, `/help`, `/legal`, `/privacy` at 1440px and
390px. **Set your machine to Light appearance first** — that is the case the
dark-only work exists to fix, and it is the one nobody checks.

Re-capture the mockups after editing them: `vp run design:mockups`.

Every new user-facing string needs a key in `en-US`, `es`, `fr` and `de`. The
glossaries are binding: Spanish board = *plafón*, gym = *rocódromo*; German
informal *du* + gender-star; French never *envoyer* for a send.

Donation copy anywhere — `/support` or the homepage support block — is covered by
`donation-disclosure.test.ts`: no perks vocabulary in any locale, and **never a
money amount**.
