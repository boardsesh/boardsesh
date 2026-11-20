# Usable gym directory search and map controls

The populated directory put Show map below the first 390 × 664 phone screen and added a second filled action in its install section. The existing map control now sits beside Search. Directory store buttons use their existing outlined appearance, leaving Search as the filled action in this measured state.

Astra's reviewed composition keeps state in GymDirectoryNearMe: the server supplies serializable search configuration and its rendered filter node; the existing state owner renders the search PageCard first and passes its single map Button through a ReactNode actions slot. The keyed GET form, URL replace/popstate behavior, near-me logic, map instance and store destinations stay intact. The map button is explicitly type=button.

## Matched directory evidence

Chromium compared base `f4f504253dff167918796b41ca805d2cc7e48549` with final application source `b35ca088a701505010afd216b4e6099fdaac29dc` at 390 × 664 and 1440 × 664. Before capture temporarily restored only the four action-placement product files; the filter styles at that point were unchanged from main. All four candidate files were restored byte for byte in finally. The final after captures include the reviewed filter-hit-area and map-reveal corrections below. Measurements and ordinary captures precede scrolling. Both phases hide only the Next development portal and development translation-editor controls. The fixture is a local fictional QA gym.

| Populated directory, 390px | Before | After |
| --- | ---: | ---: |
| Show map top | 793.48px | 460.48px |
| First listing top | 893.47px | 837.47px |
| Filled main actions | Search, App Store | Search |
| Board chips | One row of eight | One row of eight |

The map button's after bottom is 504.48px, inside the first 664px screen. The first listing remains below the 1328px two-screen bound. Neither viewport has document overflow. Desktop keeps the side-by-side map mounted once and both directory store links outlined, App Store first.

- Phone: [before first view](directory-actions-7863/before-390-viewport.png), [after first view](directory-actions-7863/after-390-viewport.png), [before directory](directory-actions-7863/before-390-directory.png), [after directory](directory-actions-7863/after-390-directory.png).
- Desktop: [before first view](directory-actions-7863/before-1440-viewport.png), [after first view](directory-actions-7863/after-1440-viewport.png), [before directory](directory-actions-7863/before-1440-directory.png), [after directory](directory-actions-7863/after-1440-directory.png).
- [Before receipts](directory-actions-7863/before-receipts.json), [final after receipts](directory-actions-7863/after-receipts.json).

The final keyboard flow changes native angle controls with Space and edits the search text without submitting. Map open/close preserves the draft and changed filters, retains other URL parameters, makes zero document GETs and mounts one map. Back restores the saved map URL/view; Forward restores the next list URL. Baseline captures cover geometry; this interaction flow ran on the final candidate.

## Native filter hit areas

Initial real pointer probes exposed cross-control collisions: angle70 intercepted angle40 in the baseline, and layout8 intercepted the Tension anchor in the first candidate. Some automatic-scroll retries also met the fixed header. [Observed error excerpts](directory-actions-7863/pointer-probe-errors.log) preserve those actual failures.

The installed MUI system's sizingTransform maps numeric width/height 1 to 100%, so the supposedly tiny transparent checkboxes covered nearby controls. Following Astra's reviewed correction, each chip label is positioned relatively and contains its checkbox at top/left zero with explicit 1px dimensions. Only the hidden input ignores pointer events; its label remains the pointer target. Native names, values, defaultChecked, tab focus and the existing :has focus/selection styling stay intact.

Final unforced mouse clicks and emulated touch taps independently toggle the 40° and 45° labels without changing the other angle, activate Tension while the narrow-filter disclosure is open, and open/close the map without losing edited text or filters. Space still toggles the focused native input and FormData contains both selected angles. Every measured layout/angle input is 1 × 1px, contained by its relative label. Both interaction modes produce zero map-button document GETs. [Final pointer/touch receipts](directory-actions-7863/filter-pointer-receipts.json).

## Explicit map reveal

A real first-screen Show map activation exposed zero visible map pixels: the 420px map began at y793.48 while scrollY remained zero. [Red measurement](directory-actions-7863/before-scroll-fix-map-intersection.json) and [before viewport](directory-actions-7863/before-scroll-fix-map-open.png) preserve that state.

Astra approved one reveal-intent ref in the existing state owner. An explicit open records intent; an effect consumes it after the map display commits and scrolls the existing map container below the fixed header with behavior auto. Closing, initial map URLs and popstate restoration do not request a scroll. The existing mobile-only button stays CSS-hidden on desktop; there is no JavaScript breakpoint, extra map, focus change or history entry.

One unforced touch tap from scrollY zero now reveals all 420 map pixels at y69.48, below the header's y53.11 bottom, with both normal and reduced motion. The document's computed scroll behavior is auto. Initial map URLs retain scrollY zero. [Final motion receipts](directory-actions-7863/map-reveal-receipts.json), [normal-motion viewport](directory-actions-7863/after-map-open-normal-motion.png), [reduced-motion viewport](directory-actions-7863/after-map-open-reduced-motion.png).

## Validation and limits

The existing claim-anchor test now verifies the actual NearMe DOM boundary; server claim-URL coverage remains. The original four directory/search/map/store suites passed all 69 cases. After both review corrections, the three relevant filters/search/map suites pass all 51 cases. The new reveal guard was committed before the fix: it failed because the expected explicit-open scroll had zero calls, then passed while also verifying no scroll on initial URL, close or popstate. [Actual red output](directory-actions-7863/map-reveal-red.log), [green suite output](directory-actions-7863/filters-map-green.log).

Full repository validation passes all 65 tasks on final application source `b35ca088a701505010afd216b4e6099fdaac29dc` (59/61 task cache hits). An earlier run compiled successfully but hit TS1128 in an ignored generated .next/dev/types/validator.ts containing duplicated trailing declarations. With no dev/Next process active, only that generated directory was archived outside the checkout; application and tsconfig files were unchanged. The succeeding full run preceded the final QA-noted preview and browser evidence. [Full successful validation output](directory-actions-7863/typecheck-map-reveal-final.log). All source and evidence commits use normal hooks.

No browser page errors occurred. The map evidence verifies the rendered map container, controls and marker plus its visibility; it does not establish production tile availability. Physical-device behavior remains unverified. This follow-up covers directory controls for #7863 and #7844, without assessing the separate gym-detail criteria.
