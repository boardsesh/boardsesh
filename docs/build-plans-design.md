# Build plans — visual system

The design system for `/build-plans*` (the CNC build-plan shop, configurator, preview,
orders and licence). It sits inside Velvet Send — see `docs/ai-design-guidelines.md` for the
palette and the web wiring — and adds the rules this one surface needs.

**Read this before touching a `/build-plans*` page.** The shared components are in
`packages/web/app/build-plans/ui/`; use them rather than a one-off `sx` block.

---

## The idea

This is a shop for shop drawings. The product is a set of DXF files a CNC router cuts from,
and the buyer is somebody standing in a garage with a sheet of plywood and a tape measure.
So the page reads like a drawing set, not like a SaaS pricing page:

- **Figures line up.** Every number on the surface — millimetres, hole counts, sheet counts,
  prices — is tabular. A cut list whose digits dance is not a cut list.
- **Hairlines, not boxes.** Structure comes from rules and a single flat card, not from a
  dozen elevated tiles.
- **One loud thing.** The landing header sits on a dot grid at a 24px pitch: the T-nut grid
  the product is actually about. Nothing else on the surface is decorated. Do not add a
  second plate, a gradient, or a glow.
- **Numbers mean sequence.** The configurator steps are numbered because they are a
  sequence. Nothing else is numbered.

---

## Page rhythm

| | Value |
|---|---|
| Max width, `wide` | `1120px` — pages with a two-column workbench (landing, configurator, orders) |
| Max width, `prose` | `760px` — a page read top to bottom with no rail |
| Body measure | `68ch` ceiling on anything read rather than scanned |
| Horizontal padding | `24px`; `16px` at ≤600px |
| Top padding | `calc(var(--global-header-height) + 32px)`; `+ 20px` at ≤600px |
| Bottom padding | `80px`; `56px` at ≤600px |
| Between top-level sections | `48px`; `40px` at ≤900px |
| Between cards in a grid | `16px` |
| Inside a card | `24px` padding (`20px` at ≤600px); `20px` from head to body |
| Between rows in a list | `10px` vertical (`6px` dense) |

`PageFrame` owns the space between sections. **A section must not carry its own top or
bottom margin** — that is how the old page ended up with margins cancelling each other.

Everything is a multiple of 4, and the section-level steps are multiples of 8.

Anchored sections (`#configure`, licence clauses) carry
`scroll-margin-top: calc(var(--global-header-height) + 24px)` so a jump clears the fixed header.

---

## Typography

System stack only (the theme's `fontFamily`). No webfont on this surface.

**MUI's `h1`, `h2`, `subtitle1` and `overline` variants are unpinned in our theme** and
inherit MUI's inflated ramp — a bare `variant="h1"` renders at ~110px and `h2` at ~68px.
That is what made this surface look slapped together. Always pin the size in the CSS module,
or use `PageFrame` / `PageSection` / `SectionCard`, which pin it for you.

| Role | Size / weight / leading | Where |
|---|---|---|
| Page title (`h1`) | 36 / 700 / 1.14, `-0.02em`, max 24ch | `PageFrame` — 28px at ≤900px |
| Page intro | 18 / 400 / 1.55, max 60ch, `--neutral-700` | `PageFrame` — 16px at ≤900px |
| Section title (`h2`) | 24 / 700 / 1.25, `-0.01em` | `PageSection` — 20px at ≤900px |
| Section intro | 16 / 400 / 1.5, max 68ch, `--neutral-500` | `PageSection` |
| Card / step title | 18 / 600 / 1.35 | `SectionCard`, `StepHeading` |
| Card description | 14 / 400 / 1.5, max 64ch, `--neutral-500` | `SectionCard` |
| Body | 16 / 400 / 1.5 | `body1` |
| Secondary, helper, list label | 14 / 400 / 1.5, `--neutral-500` | `body2` |
| Figure / value | 14 / 600, tabular | `KeyValueList` |
| Price | 24 / 700 / 1.2, tabular (`lg`: 30) | `PriceTag` |
| Status pill | 12 / 600 / 16px line | `StatusChip` |
| Legal body | 16 / 400 / **1.7**, max 68ch | licence clauses only |

Do not use: all-caps eyebrow labels, `variant="overline"`, a monospace face for data labels,
an arrow appended to link text, or a single accented word inside a heading.

---

## Colour

Only the CSS custom properties from `app/components/index.css`. **No hex, no `rgba()`
literal, in any `.module.css` on this surface.**

| Job | Token |
|---|---|
| Page base | `--semantic-background` |
| Card / plate | `--semantic-surface` |
| Quiet card | `--neutral-50` |
| Hairline, card border, row rule | `--neutral-200` |
| Dashed border (empty state) | `--neutral-300` |
| Primary text | inherited (`--neutral-800` via the theme) |
| Secondary text, labels, notes | `--neutral-500` |
| Links, step numerals, accent rule, focus | `--color-primary` (foreground violet) |
| The one filled button | `--color-primary-fill` + `--color-on-primary` (MUI `variant="contained"`) |
| Dot grid on the landing plate | `--semantic-selected-hover`, 1.6px dots at a 24px pitch |
| Accent card rule | `--color-primary` inset, `--semantic-selected-border` on the border |

The amber `--color-accent` is **not** used on this surface. It is a fill-only spark with a
single job on the landing hero CTA, and a second amber here would make it mean nothing.

One filled violet button per view. Everything else is a text link or an outlined button.

### Status colours

`StatusChip` maps all eleven order states — the seven in `CncOrderStatus` plus the four the
preview flow adds — onto six tones. Tone is a verdict, not a colour choice:

| Status | Tone | Reads as |
|---|---|---|
| `pending_payment`, `cancelled` | `neutral` (`--neutral-600` on `--neutral-100`) | nothing is happening, nothing is wrong |
| `preview_queued`, `preview_generating`, `queued`, `generating` | `progress` (`--color-info` on `--semantic-selected-light`) | the generator has it; come back |
| `preview_ready` | `brand` (`--color-primary` on `--semantic-selected`) | free preview is ready; the next move is yours |
| `ready` | `success` (`--color-success` on `--color-success-bg`) | the paid pack is downloadable |
| `refunded` | `warning` (`--color-warning` on `--color-warning-bg`) | download is off, nothing broke |
| `failed`, `preview_failed` | `error` (`--color-error` on `--color-error-bg`) | it did not build |

`preview_ready` and `ready` **must not look alike** — one wants finalising, the other is
already yours. Violet vs green is the whole point.

`orderStatusChipColor` in `order-display.ts` is superseded by `StatusChip` and should be
deleted with the orders restyle: it maps onto MUI `Chip` colours, it has no case for the four
preview states, and its exhaustive `switch` stops compiling the moment they land in
`CncOrderStatus`.

---

## Cards and surfaces

One card, four tones. Not MUI's `Card`: the theme gives every `Card` a resting shadow and a
hover shadow, and a page made of a dozen of those reads as a pile of floating tiles.

| | |
|---|---|
| Radius | `--border-radius-lg` (12px); the landing plate uses `--border-radius-xl` (16px) |
| Border | `1px solid var(--neutral-200)` — the same hairline as `/gyms` and the landing rails |
| Background | `--semantic-surface` (`quiet` → `--neutral-50`) |
| Shadow | **none**, except `raised` (`--shadow-sm`) |
| Hover | **none**. A card here is not a target; the link inside it is |

**A shadow on this surface means one thing: the element floats.** That is the sticky summary
rail and nothing else. If you want a card to stand out, use `tone="accent"` — a 3px violet
rule down its leading edge — and use it on at most one card per view.

---

## Form controls

The MUI theme already gives you: `TextField` defaults to `variant="outlined"` `size="small"`,
10px radius, `--input-*` surfaces in both schemes, 16px input text (the iOS zoom guard),
`FormLabel` at 14/500, `FormHelperText` at 12 with `marginTop: 4px`, and a violet 2px focus
outline on every `ButtonBase`. **Do not re-specify any of that.**

- Selects and text inputs: `size="small"`, `fullWidth`, laid out in `FieldGrid`.
- Every field carries its helper text. The configurator's helpers explain a shop decision
  ("18 mm is standard. Thinner flexes"); they are not filler and must not be dropped for
  density.
- Binary machining options are `Switch` rows; a choice between two priced things is a
  `RadioGroup` (never two checkboxes).
- Buttons: `size="large"` for a page's primary action, default size everywhere else. Never
  set `textTransform` — the theme already does.
- `Alert`: pass `sx={{ borderRadius: 'var(--border-radius-lg)' }}`; the theme has no Alert
  override.

---

## The component kit

`packages/web/app/build-plans/ui/` — import from the barrel: `import { PageFrame, … } from './ui'`.

| Component | Props |
|---|---|
| `PageFrame` | `title`, `intro?`, `eyebrow?`, `actions?`, `note?`, `width?: 'wide' \| 'prose'`, `plate?`, `children` |
| `PageSection` | `id?`, `title`, `intro?`, `action?`, `headingLevel?: 'h2' \| 'h3'`, `children` |
| `SectionCard` | `id?`, `title?`, `description?`, `action?`, `tone?: 'default' \| 'quiet' \| 'raised' \| 'accent'`, `padding?: 'default' \| 'tight' \| 'flush'`, `headingLevel?: 'h2' \| 'h3' \| 'h4'`, `component?`, `className?`, `children?` |
| `StepHeading` | `step: number`, `title`, `description?`, `done?`, `id?`, `headingLevel?` |
| `KeyValueList` | `items: { key, label, value, hint? }[]`, `columns?: 1 \| 2`, `layout?: 'row' \| 'stacked'`, `dense?`, `aria-label?` |
| `PriceTag` | `amount` (already formatted), `note?`, `size?: 'md' \| 'lg'` |
| `StatusChip` | `status: BuildPlanStatus`, `label` (translated by the caller) |
| `SplitLayout` | `children` (the form), `rail`, `railLabel` |
| `FieldGrid` | `children`, `columns?: 'auto' \| 'single'` |
| `PreviewGallery` | `images: { name, url, label }[]`, `note?`, `actions?`, `aria-label?` |
| `EmptyPanel` | `title`, `body?`, `action?` |

Notes that matter:

- `StatusChip` takes its **label as a prop**, so it renders in a server component
  (`getServerTranslation`) and a client one (`useTranslation`) alike. `BuildPlanStatus` is a
  superset of `CncOrderStatus` that already includes the four preview states.
- `PriceTag` takes a **formatted string**, not cents. `formatPrice(amountCents, currency, locale)`
  in `configurator/configurator-state.ts` is the one formatter on this surface.
- `SectionCard`'s `className` is for a page-level concern the card cannot know about (an
  anchor's `scroll-margin-top`). It is not for restyling; a card that needs a different
  surface needs a new `tone`.
- `EmptyPanel` is deliberately not `components/ui/empty-state.tsx` — that one is a centred
  client component with an inbox icon. Build-plans empty states are server-rendered,
  left-aligned, and always carry an action.

---

## Pages

### `/build-plans` — the shop

Reading order is the buying order. The one filled button lives in the header and jumps to
`#configure`; everything below it is a text link.

```
DESKTOP 1280                                    max 1120px
┌──────────────────────────────────────────────────────────┐
│ · · · · · · · · · · · · · · · · · · · · · · · · · · · ·  │  ← plate: dot grid, 24px pitch
│ · Build plans for your home board · · · · · · · · · · ·  │     h1 36px, max 18ch
│ · · · · · · · · · · · · · · · · · · · · · · · · · · · ·  │
│ · DXF files a CNC shop cuts straight from. Every · · · · │     intro 18px, max 60ch
│ · panel, the T-nut grid, the LED holes… · · · · · · · ·  │
│ · · · · · · · · · · · · · · · · · · · · · · · · · · · ·  │
│ · [ Configure your wall ]  Read the licence  Your plans  │     1 filled + 2 links
│ · Kilter Homewall is the first supported board. · · · ·  │     note, neutral-500
└──────────────────────────────────────────────────────────┘
                                    ↕ 48
  How it works                                                  h2 24px
  Previews are free. Nothing is charged until you finalise.
  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
  │ (1) Configure  │ │ (2) Free       │ │ (3) Finalise   │      StepHeading in a
  │     your wall  │ │     preview    │ │     and build  │      tight SectionCard
  │ Pick the size… │ │ We lay out…    │ │ Name the…      │
  └────────────────┘ └────────────────┘ └────────────────┘
                                    ↕ 48
  What you get
  ┌──────────────────────────────────────────────────────┐
  │ One DXF per panel        │ Check sheets              │     KeyValueList
  │ One DXF per panel, plus… │ Printable A3 or Tabloid…  │     stacked, 2 columns
  │ ─────────────────────────┼────────────────────────── │
  │ A cut list               │ Your licence              │
  │ Sheet count, panel…      │ A licence with your name… │
  └──────────────────────────────────────────────────────┘
                                    ↕ 48
  Pick a licence
  One licence, one wall. A second wall needs a second licence.
  ┌───────────────────────────┐ ┌───────────────────────────┐
  │ Personal                  │ │ Commercial, single build  │
  │ A$149.00                  │ │ A$750.00                  │  PriceTag lg, tabular
  │ per wall                  │ │ per wall                  │
  │ Build one wall for…       │ │ Build one wall for one…   │
  └───────────────────────────┘ └───────────────────────────┘
  ┌──────────────────────────────────────────────────────┐
  │ Building more than one?                              │  tone="quiet"
  │ Ten-build packs and OEM terms are a conversation…    │
  │ Email us                                             │
  └──────────────────────────────────────────────────────┘
                                    ↕ 48
  #configure  ── the configurator (see below)
                                    ↕ 48
  Boardsesh is not affiliated with Aurora Climbing… (68ch, neutral-500)
```

```
MOBILE 390
┌────────────────────────────┐
│ · · · · · · · · · · · · ·  │  plate, 24px padding
│ · Build plans for your · · │  h1 28px
│ · home board · · · · · · · │
│ · DXF files a CNC shop…  · │  16px
│ · [ Configure your wall ] ·│  full-width-ish
│ · Read the licence · · · · │  links wrap
│ · Your build plans · · · · │
│ · Kilter Homewall is… · ·  │
└────────────────────────────┘
        ↕ 40
  How it works
  ┌──────────────────────────┐
  │ (1) Configure your wall  │   cards stack, 16 apart
  └──────────────────────────┘
  ┌──────────────────────────┐
  │ (2) Free preview         │
  └──────────────────────────┘
  ┌──────────────────────────┐
  │ (3) Finalise and build   │
  └──────────────────────────┘
        ↕ 40
  What you get   (KeyValueList collapses to 1 column at ≤700px)
  Pick a licence (tier cards stack)
  #configure
```

### `/build-plans#configure` — the configurator

A guided, sectioned flow inside `SplitLayout`. Each step is a `SectionCard` with a
`StepHeading`; fields go in a `FieldGrid`. The rail carries what gets cut, the price, and the
one primary action, and it is the only element on the surface allowed a shadow.

```
DESKTOP ≥1000px                    minmax(0,1fr)  │  320px sticky
┌──────────────────────────────────────────┐  ┌──────────────────┐
│ Configure your wall                   h2 │  │ What gets cut    │  raised, sticky at
│ Everything below changes what gets cut.  │  │ ──────────────── │  header + 16px
│                                          │  │ Wall  2440×3048  │
│ ┌──────────────────────────────────────┐ │  │ Panels        3  │  KeyValueList dense,
│ │ (1) Your wall                        │ │  │ Sheets        4  │  tabular figures
│ │ ┌──────────┐ ┌──────────┐            │ │  │ T-nut holes 305  │
│ │ │ Board  ▾ │ │ Size   ▾ │  FieldGrid │ │  │ LED holes   590  │
│ │ └──────────┘ └──────────┘            │ │  │ ──────────────── │
│ │ [x] Include the kicker               │ │  │ Free preview     │
│ └──────────────────────────────────────┘ │  │ [ Get a free     │
│ ┌──────────────────────────────────────┐ │  │   preview ]      │  the one filled
│ │ (2) Manufacturing                    │ │  │ No card needed.  │  button
│ │ ┌────────┐┌────────┐┌────────┐       │ │  └──────────────────┘
│ │ │Sheet ▾ ││Thick ▾ ││T-nut ▾ │       │ │
│ │ └────────┘└────────┘└────────┘       │ │
│ │ helper text under every field        │ │
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ (3) Engraving        [switch rows]   │ │
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ (4) Custom text and logos            │ │
│ │  ┌──────────────────────────────┐    │ │
│ │  │  wall canvas (placement)     │    │ │
│ │  └──────────────────────────────┘    │ │
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ (5) Your preview      [ Preview ● ]  │ │  ← StatusChip in the card head
│ │  ┌────┐ ┌────┐ ┌────┐ ┌────┐         │ │
│ │  │pnl1│ │pnl2│ │pnl3│ │asmb│         │ │  PreviewGallery, 4:3 tiles,
│ │  └────┘ └────┘ └────┘ └────┘         │ │  watermark legible
│ │  Watermarked. Finalise to get the DXF│ │
│ │  [ Download the preview ]            │ │
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ (6) Who the licence names            │ │  only after preview_ready
│ │  name / email / tier / accept        │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘

MOBILE 390: one column. The rail falls BELOW the form, in DOM order — that is
where a buyer meets it after answering the questions. The primary action goes
with it; do not float a sticky bar over the placement canvas.
```

Rules for whoever builds this:

1. **Steps are `SectionCard` + `StepHeading`, numbered 1..n in render order.** Mark a step
   `done` once it is answered.
2. **Never gate a step behind sign-in that could be answered signed out.** Configuring and
   reading the summary need no account; only generating a preview does.
3. **The preview step is a step, not a modal.** It sits in the flow between artwork and the
   licensee fields, and its state lives in a `StatusChip` in its card head.
4. **"Update preview" replaces "Get a free preview"** once the config changes after a
   preview — same button, same place, changed label. Never two preview buttons.
   The rail owns that button through every state — preview, update, finalise — so the
   preview card's own actions stop at the download; a second Finalise inside the gallery
   would be the second filled button this surface does not allow.
5. `PageSection` owns the heading for the configurator once it moves out of
   `Configurator`'s own `SectionCard`; do not render two headings.

### The preview gallery

```
┌──────────────────────────────────────────────────────┐
│ Watermarked, 110 dpi. Finalise to get the DXF.       │  note, 68ch, neutral-500
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │
│ │ ▨ 4:3  │ │ ▨      │ │ ▨      │ │ ▨      │          │  auto-fill, min 180px
│ │ neutral│ │        │ │        │ │        │          │  contain on --neutral-50
│ │ -50    │ │        │ │        │ │        │          │
│ └────────┘ └────────┘ └────────┘ └────────┘          │
│  Panel 1     Panel 2    Panel 3    Assembly          │  caption 12px, tabular
│                                                      │
│ [ Download the preview ]                             │
└──────────────────────────────────────────────────────┘
```

The watermark is the point of this screen. **Nothing may dim, crop, overlay or lightbox the
images**, and no hover zoom. Tiles are `object-fit: contain` at 4:3 on `--neutral-50`, so a
panel drawing and the assembly sheet sit at the same size and
"PREVIEW · NOT FOR MANUFACTURE" stays legible in the thumbnail.

### `/build-plans/orders` — the list

Compact rows, not cards with pictures. Newest first. The licence id is the row's identity and
is tabular, because buyers read them off an invoice.

```
DESKTOP 1280                                  max 1120px
  Your build plans                                          h1
  Every pack you have bought, newest first.                 intro

  ┌────────────────────────────────────────────────────────┐
  │ BS-CNC-4K7QP2       Kilter 10×12 · Personal            │  id 600 tabular,
  │ Ordered 14 Aug 2026                        ● Ready     │  meta neutral-500,
  │                                                  Open →│  StatusChip right
  ├────────────────────────────────────────────────────────┤
  │ BS-CNC-9RT2XM       Kilter 8×12 · —                    │
  │ Previewed 2 Sep 2026                  ● Preview ready  │  brand tone
  │                                             Finalise → │  ← the actionable row
  └────────────────────────────────────────────────────────┘

MOBILE 390
  ┌──────────────────────────┐
  │ BS-CNC-4K7QP2            │  id on its own line
  │ Kilter 10×12 · Personal  │
  │ Ordered 14 Aug 2026      │
  │ ● Ready          Open →  │  chip and link share the last row
  └──────────────────────────┘
```

- One `SectionCard padding="tight"` per order, or one flush card holding hairline-separated
  rows. Either is fine; do not mix them on one page.
- A `preview_ready` row is the only one that may take `tone="accent"`, and only when it is
  the newest.
- Empty: `EmptyPanel` with `orders.empty` and a "Configure a wall" button. Never a bare
  "No data".

### `/build-plans/orders/[licenceId]` — one order

`PageFrame` with the licence id as the title (tabular), the `StatusChip` in `eyebrow`
alongside a back link, then: what it is (`KeyValueList`), where it is up to (the timeline),
the preview gallery if there is one, and the download. Downloads are the primary action and
appear once — in the card, not in the header.

### `/build-plans/licence` — the terms

A reading page, not a sales page. Contents rail left, document right; the rail sticks under
the header. The document sits on a card — the card is the sheet the terms are printed on —
and the rail does not, because it is navigation around the sheet rather than part of it.
Inside the sheet the clauses are separated by rules, not by twelve more cards.

Clause numbers come from the catalog copy ("3. Personal licence (A$149)"), never from a CSS
counter — those numbers are part of a licence someone may quote back at us.

```
DESKTOP ≥1000px                    220px  │  minmax(0,1fr)
  ← Back                                                      eyebrow
  Build plans manufacturing licence                           h1
  This is the agreement that comes with every build pack…     intro

  ⚠ Draft licence
    Pending review by an Australian IP lawyer; do not rely on it yet.

  ┌───────────────┐   ┌────────────────────────────────────┐
  │ Contents      │   │ Boardsesh Build Plans              │  documentTitle 24px
  │ ───────────── │   │ Manufacturing Licence              │
  │ 1. Parties…   │   │ ────────────────────────────────── │  hairline per clause
  │ 2. What you…  │   │ 1. Parties and definitions         │  clause title 18/600
  │ 3. Personal…  │   │ Boardsesh The project that…        │  body 16/1.7, 68ch
  │ 4. Commercial │   │ ────────────────────────────────── │
  │ 5. Ten builds │   │ 3. Personal licence (A$149)        │
  │ …             │   │ One wall, your own non-commercial… │
  │ 12. Contact   │   │ ┌───────────┬────────────────────┐ │
  │ ───────────── │   │ │ You may   │ You may not        │ │  side-by-side rules,
  │  (sticky)     │   │ │ ───────── │ ────────────────── │ │  not two bullet lists
  │               │   │ │ Manufactu…│ No manufacture for…│ │
  │               │   │ │ Cut the p…│ No resale, redist… │ │
  │               │   │ └───────────┴────────────────────┘ │
  │               │   │ ────────────────────────────────── │
  │               │   │ This page is a draft…              │  footer, ruled off
  └───────────────┘   └────────────────────────────────────┘

MOBILE 390
  ← Back
  Build plans manufacturing licence
  ⚠ Draft licence
  Contents            ← plain list above the text, not sticky
  1. Parties…
  …
  Boardsesh Build Plans Manufacturing Licence
  ─────────────────────────
  1. Parties and definitions
  …
  You may            ← the two rule columns stack at ≤760px
  · Manufacture one wall…
  You may not
  · No manufacture for sale…
```

The DRAFT alert stays first in the document flow. Anyone arriving from a purchase flow has to
see "not lawyer-reviewed" before they read a term.

---

## Empty, loading and error states

- **Empty** → `EmptyPanel`, always with an action. "No one's here yet" over "No data
  available"; an empty screen is an invitation to act.
- **Loading a figure** → keep the row and show the label with a `—` value, or a `Skeleton`
  the width of the value. Never collapse the row: a summary that changes height while the
  layout is computed makes the whole card jump.
- **Loading a preview** → the gallery's card keeps its head, shows the `progress` `StatusChip`
  and one line of copy. No spinner-only card.
- **Error** → MUI `Alert severity="error"` with `borderRadius: var(--border-radius-lg)`,
  inside the card the error belongs to, not at the top of the page. Say what happened, what
  it cost ("Nothing was charged"), and what to do next. The `cnc.errors.*` catalog already
  writes them this way.
- **Blocked action** → never a disabled button with no explanation. Disable it and put the
  reason underneath in `body2`.

---

## Copy

All strings come from `packages/shared/i18n/locales/*/cnc.json` and `cnc-legal.json`, in all
four locales, and the Spanish, French and German glossaries in `docs/i18n-*-glossary.md`
apply. Reminders for this surface:

- Say what the buyer gets, not what the system does. "Cutting the files", not "Generating
  artefacts".
- Active CTAs that name what happens: "Get a free preview", "Finalise and buy",
  "Download the pack". An action keeps its name through the flow.
- Shop vocabulary, not SaaS: sheets, panels, T-nuts, kicker, cut list, shop. Not "assets",
  "solutions", "seamless".
- Money is explicit and reassuring at every step of the free half: "Previews are free",
  "No card needed", "Nothing was charged".
- Compatibility, never endorsement: "Works with Kilter", not "Kilter plans". Capitalise
  MoonBoard, Kilter, Tension.

---

## Rules

1. Import from `./ui`. A new one-off panel means the kit is missing something — add it there.
2. No hex or `rgba()` in a `.module.css` on this surface.
3. No `style` prop. `sx` for one-off spacing, the CSS module for anything structural.
4. One `<h1>` per page, from `PageFrame`.
5. One filled violet button per view.
6. A shadow means "this floats". Nothing else gets one.
7. Numerals mean a sequence. Nothing else gets numbered.
8. Every figure is tabular.
9. Sections do not carry their own margins.
10. Pin `h1`/`h2` sizes; never use the raw MUI variants.
