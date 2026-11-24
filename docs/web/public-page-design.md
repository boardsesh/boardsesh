# Public page design: climb pages and their siblings

Most new climbers meet Boardsesh on a page Google sent them to: about 100,000
climb pages, 10,000 setter pages, 9,000 playlists and 700 board lists. This page
describes how those pages are built after the 2026-11 redesign, so a change to
one keeps the rules the others follow. The climb page
(`packages/web/app/components/climb-front-door/climb-front-door.tsx`) is the
reference implementation; board lists, setter and playlist pages reuse its
parts.

## Layout

The DOM order is the phone order. CSS decides the desktop layout.

1. **Phone (below 900px, MUI `md`).** One column: breadcrumb, title, board,
   call to action, details, then the full-width bands. The board art starts
   within 600px of the top on a 390x844 screen.
2. **Desktop (900px and up).** The hero is its own grid
   (`climb-front-door.module.css`): the board sticky on the left
   (`minmax(0, 560px)`), the title, call to action and details down the right
   (`minmax(360px, 1fr)`). The board's height is capped so the whole board fits
   at 1440x900. The hero is a separate grid from the full-width bands because
   Chromium bounds a sticky grid item by its grid container: in one page-wide
   grid the board would slide over everything below it.
3. **Full-width bands** follow the hero: "What you get in the app"
   (`climb-app-showcase.tsx`), "Climbs like this one" (`SimilarClimbsList`, rows
   in the app's format) and the comments row (`deferred-climb-social.tsx`).

Wrappers are MUI components (`Box component="main"`, `Box component="section"`),
never raw `<div>`s. Colours come from the CSS variables in
`app/components/index.css` or `themeTokens`; nothing is hardcoded. The page is
dark only.

The board image is the page's LCP: a plain server `<img>` with explicit
`width`/`height` and `fetchPriority="high"`, never a client renderer. Everything
below the fold is lazy and sits in a box of fixed size, so nothing moves when it
loads.

## The page is cached for everyone

`middleware.ts` puts a 24-hour shared CDN cache on every climb URL with no
user-agent or session split. So the server HTML must be the same for Googlebot,
an iPhone and a laptop:

- **No visitor-specific markup.** Both store links are always in the HTML. The
  phone's store is picked before hydration with
  `@supports (-webkit-touch-callout: none)` (iOS gets the App Store), then by
  `useInstallPlatform` after mount, but only when it names one store: an
  Android phone, an iPhone, or the retired app's update
  (`mobile-store-primary.tsx`). A desktop window under md names both stores,
  so its CSS guess stands and no badge swaps at hydration.
- **App screenshots render one neutral platform on the server.** The app module
  wraps its screenshots in a `MarketingPreviewProvider` seeded with a user agent
  nobody sends, and swaps to the reader's phone after mount. The root layout's
  provider reads the request's user agent, which a cached page must not trust.
- **Nothing personal.** No ticks, no "signed in as". The comments row renders
  signed out on the server and changes after mount.
- **Report a problem** on a `/b/{slug}` list ("Something wrong with this
  board?") is the same markup for everyone. Whether it renders depends only on
  the `directory-reports` flag, which is one answer for every visitor; the
  session, the board's creator and its gym are read in the browser after a tap
  (`board-report-link.tsx`, docs/product/directory-reports.md).
- `front-door-install.test.tsx` renders the page as if Googlebot Smartphone, an
  iPhone, a desktop or a request with no user agent filled the cache, and fails
  if any of them changes the store links or the app screenshots.

## Calls to action

One primary action per screen.

| Where | Phone | Desktop |
| --- | --- | --- |
| Hero | The store badge for that phone (one store shown) | Filled "Open in your browser" next to a QR code |
| Hero, second action | "Or open it in your browser" text link | QR card with both store badges |
| Bottom of the screen | Sticky install bar, after the hero badge scrolls away | None |
| App module | Store badges (one store after mount) | Both store badges |

Why the phone's primary action is the store: phones with the app open climb
links straight in the app (universal links), so a phone reading the web page
almost never has it. Before the redesign the filled button sent phones to the
browser app, which cannot light a board on an iPhone, and climb pages logged
zero store clicks in 30 days. On a laptop the browser app works, so the
hand-off stays primary there, and the QR code carries the climb to the phone.

The split is CSS only (MUI `sx` breakpoints), so nothing shifts after paint.
The phone's store link (`data-cta="mobile-install"`) is the official badge, so
`front-door-install.test.tsx` fails if a climb or list page renders any
`contained` button: the hand-off is a text button that CSS fills from md. The
app module's pair (`data-cta="app-install"`) is `StoreInstallButtons`, which
renders badges too, so it never adds a second filled button to a screen.

## Store badges

Every www store link is the official badge, the artwork Apple and Google
publish, in the page's language: `StoreInstallButtons` (home, /help, the QR
cards, the app module, spray walls), the phone's hero badge on climb, board-list
and playlist pages (`MobileStorePrimary`) and the gym page's pair
(`GymInstallCta`). All of them draw it through one anchor,
`components/marketing/store-badge-link.tsx`, which marks it
`data-store-badge="ios|android"`. Two links stay text on purpose: the sticky
install bar's "Get the app", and the "Update the app" button below.

The files are in `packages/web/public/images/store-badges/`;
`app/lib/store-badges.ts` maps a store and locale to a file and its size. To
update a badge, download it again and replace the file:

| Files | Source |
| --- | --- |
| `app-store-{black,white}-<locale>.svg` | Apple Marketing Tools: `https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/{black,white}/<apple-locale>` |
| `google-play-<locale>.svg` | Google Partner Marketing Hub, [Google Play badges](https://partnermarketinghub.withgoogle.com/brands/google-play/google-play/lockups-icons-badges/#badges): `Badge_GetItOnGP_<locale>_Digital_Fullcolor_GooglePlay`, the SVG |

Our `en-US`, `es`, `fr`, `de`, `it` and `zh-CN` take the stores' `en-us`,
`es-es`, `fr-fr`, `de-de`, `it-it` and `zh-cn` artwork. Spanish uses the Spain
badges ("Consíguelo en el App Store", "Descargar en Google Play"); Apple also
publishes `es-mx` and Google `es-419`.

- **Never edit the artwork.** No recolouring, cropping, glow or hover effect.
  The anchor around a badge adds only a focus ring.
- **Black, except one case.** Apple allows its white badge only when it is the
  one store badge on the page, and Google Play is black only. So the App Store
  badge is white only when it stands alone on a page rendered per request that
  shows no other store badge (an iPhone on a localized, uncached homepage), at 48px. Every
  other badge is black. Pairs, and every `StoreInstallButtons` badge on shared
  HTML (which starts as a pair for everyone), are 44px, so nothing changes
  colour or size at hydration. The phone's hero badge on climb, board-list and
  playlist pages is black and 48px: both stores are in the shared HTML, stacked
  in one grid cell, CSS shows exactly one and hides the cell from md, and it is
  centred over the helper line. It stays black because the same page shows
  another store pair further down (the app module, the QR card).
- **The gym page** shows both badges, always: black, 44px, App Store first,
  neither styled as the primary, so the look does not tilt the per-platform
  split of `App Install Click`.
- **Sizes.** Both heights clear the 44px target and Apple's 40px minimum. At
  the same height Google Play is wider than the App Store badge, which is what
  Google asks for. 12px between badges is more than the quarter-height clear
  space both stores want.
- **Alt text is the badge's own words** in the page's language
  (`marketing.home.hero.ctaInstallIos` / `ctaInstallAndroid`, through
  `getStoreButtonLabels()` on the server), so a screen reader says what a
  sighted reader sees. The anchor carries no `aria-label` over it, and
  `label-in-name.test.ts` checks every locale's words name the store the badge
  shows.
- **Update mode stays text.** A visitor still on the retired Capacitor app gets
  an "Update the app" button: "Download on the App Store" would be the wrong
  words for them. `appearance` styles only that button now.
- **Credit line.** The footer carries Apple's and Google's trademark credit
  (`common.footer.storeTrademarks`), which Apple requires wherever its badge
  appears.

The sticky bar (`sticky-install-bar.tsx`) shows only below md, on Android and on
iOS browsers that show no Smart App Banner (Safari already shows ours). It stays
down while the consent card is up, and while any element marked
`data-sticky-install-hide` is on screen: the hero's store block and the app
module's store pair both carry it. The bar watches `<main>` for markers that
stream in after it mounts, since the app module renders inside `<Suspense>`.

## Attribution

Every store link has its own placement, which is also its store link id
(`app/lib/app-install-event.ts`): `climb-view` (the phone's hero badge),
`climb-qr-card` (the desktop QR card), `sticky-bar` and `climb-app-module`.
The home page uses the same QR card: `hero` is the phone's badge and
`home-qr-card` the laptop's pair, and a scan fires `Home QR Scanned`.

Board lists, setter pages and playlists follow the same pattern with their own
placements: `climb-list` / `climb-list-qr-card`, `setter` / `setter-qr-card`
and `playlist` / `playlist-qr-card`. The playlist page builds its hero from the
same parts (`front-door-cta-parts.tsx`) and takes the QR card as a slot the
server renders, so `qrcode.react` stays out of the client bundle. A private
playlist gets no QR card.

The desktop QR code encodes the page the reader is on plus
`?src=qr&medium=desktop` (`climbQrUrl` in `app/lib/gym-attribution.ts`, and
`listQrUrl`, `setterQrUrl`, `playlistQrUrl` for the other pages). The phone
that scans it fires `Climb QR Scanned` (or the list, setter or playlist
sibling) once per landing, after consent
(`qr-landing-tracker.tsx`), and a store click after a scan carries
`qrMedium = 'desktop'` and the link id `<placement>.desktop`. The server never
reads those parameters, so the cached HTML stays the same. Event contracts:
`docs/analytics/gym-funnel-analytics.md`; the dated annotations:
`docs/analytics/growth-metrics.md`.

## The CI gate

`packages/web/e2e/public-page-overflow.spec.ts` runs in CI's typecheck job. It
walks list, climb and setter pages at 390px and 1440px and fails on:

- **Tap targets.** Every visible link and button in `<main>`, the header and the
  footer is at least 44x44px. Inline links get `minHeight: 44` and
  `display: inline-flex`. A whole-row link is the row itself, not a
  `::after` overlay: the gate measures the element's own box.
- **Contrast.** Every glyph clears 4.5:1 against its real background, including
  `aria-hidden` text such as grade tiles and separators. `--neutral-400` fails
  on these backgrounds: use `--neutral-500` or lighter for muted text. Text over
  an image or a gradient is reported as unresolved rather than measured; keep
  it white on a dark scrim.
- **Overflow.** No horizontal page scroll at 390px or 1440px. A horizontal
  scroller bleeds to the screen edge with
  `margin-inline: calc(-1 * var(--page-gutter))` inside `<main>`, whose
  `overflow-x: clip` keeps it off the page width.
- **Focus.** A keyboard-focused link shows a 2px outline at 3:1 or better.

Run it locally against a dev server with `--grep journey --trace off`.

## What the app module sells

"What you get in the app" sells five things, in this order (owner's list,
2026-11-22). Each card is a real picture, a heading and one sentence.

1. **Instant beta.** A linked beta video shows on the climb for everyone straight
   away. The picture is this climb's own beta thumbnails (up to three, with the
   filmers' handles), the same links the page's beta section already shows, and
   a plain play tile when it has none or a thumbnail fails. Never other climbs'
   beta: a climber can make a video private at any time, and this HTML sits in a
   shared edge cache for a day, so revocable user media must never be copied into
   it from another climb. The handle sits on a solid pill so it reads on a white
   thumbnail.
2. **Know what's on the board.** The board's history is shared live: everyone at
   the board sees what's lit now and what was up before it. The `wall-status`
   capture.
3. **Every board, one app.** "One app for all your boards. Works with Kilter,
   Tension, MoonBoard and more." Never "one app for Kilter": we describe
   compatibility, not affiliation (`LEGAL.md`). The homepage poster, cropped to
   its three phones by CSS.
4. **One logbook.** Every send from every board in one place, with a link to
   Bring your logbook. The `profile` capture.
5. **Workouts.** 4x4s and volume sessions at your grade, with a built-in timer.
   The `workouts` capture.

The 30-day line under the cards comes from `cachedCommunityStats()` through
`formatCommunityProof()` (`app/lib/community-proof.ts`), the same sentence and
rounding the homepage hero uses. It renders inside its own `<Suspense>`, so
neither the hero nor the store pair waits on it, and it is left out when the
numbers did not load.

## Where the pictures come from

No AI-generated images, anywhere. Every picture is a real capture or photo:

- **App captures** (`packages/web/public/images/app/{ios,android}/*.webp`) are
  the English App Store and Play Store screenshot sets, resized. The registry is
  `app/lib/marketing-screenshots.ts`; render them through `MarketingScreenshot`.
  `workouts.webp` exists for Android only: it is the phone screen cropped at full
  resolution (804x1429) out of
  `app-stores/google/screenshots/pixel-2/06-workout-generator.png`, without the
  store headline. iPhone readers see this Android capture on the Workouts card
  until the App Store set has a workout shot; add it to the registry then.
- **The board poster** is the homepage's `images/home/showcase-hero-9x16.webp`.
- **Beta thumbnails** come from each beta link, as in the beta grid. They are
  plain `<img>`s with `referrerPolicy="no-referrer"`, not `next/image`, and a
  failed one becomes a play tile (`beta-fan-card.tsx`).
- **Board art** is rendered by the backend's `/render/board` overlay.

After adding or changing an image under `packages/web/public/images`, run
`vp run generate:static-assets` and commit the catalog it writes
(`docs/operations/static-assets.md`).
