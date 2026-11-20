# Gym directory first-view actions

The populated directory put Show map below the first 390 × 664 phone screen, and its install section added a second filled action beside the page's Search. The existing map control now sits in the search submit row. Directory store buttons use the existing outlined appearance, leaving Search as the filled action in this measured state.

The planning recommendation from Astra keeps state in GymDirectoryNearMe: the server supplies serializable search configuration and its rendered filter node; the same state owner renders the existing search PageCard before its location controls and passes its single map Button through a ReactNode actions slot. The button is explicitly type=button. The keyed form, URL replace/popstate behavior, near-me logic and map mounting policy stay in that owner. The filters remain inside the same GET form. The store appearance is selected only at the directory call site.

The existing claim-anchor regression moved from shallow server-tree serialization to the actual NearMe DOM boundary: the real closing claim link resolves to exactly one anchor containing the search input. Existing server claim-URL coverage remains. All 69 cases in the four existing directory/search/near-me/store suites pass; all 65 repository typecheck tasks and normal commit hooks pass on application source `fdf2ba8de978643cdc755072b6b6cc1f68d4f015`.

## Matched directory evidence

Chromium compared base `f4f504253dff167918796b41ca805d2cc7e48549` with the candidate in the same local seeded runtime at 390 × 664 and 1440 × 664. Before capture temporarily restored only the four product files; all four candidate files were restored byte for byte in finally. Measurements and ordinary captures precede any scrolling. Both phases hide only the Next development portal and development translation-editor controls. The fixture is a local fictional QA gym.

| Populated directory, 390px | Before | After |
| --- | ---: | ---: |
| Show map top | 793.48px | 460.48px |
| First listing top | 893.47px | 837.47px |
| Filled main actions | Search, App Store | Search |
| Board chips | One row of eight | One row of eight |

The map button's after bottom is 504.48px, inside the first 664px screen. The first listing remains above the two-screen bound of 1328px. Both viewports have no document overflow. On desktop the existing side-by-side map remains mounted once, and both directory store links are outlined with App Store first.

The candidate's real keyboard flow changes an angle checkbox with Space and edits the input without submitting. Enter opens and closes the map while preserving both draft text and the changed filter; the current URL retains q, board type and angle while view=map is added/removed. There are zero document GET requests from the map toggle and one map instance. Back restores the saved map URL/view; Forward restores the following list URL. No browser page errors occurred. Baseline capture covers geometry; this interaction flow was run on the candidate.

Initial pointer probes were intercepted by existing transparent filter inputs (angle70/layout8), and some automatic-scroll retries met the fixed header. Pointer activation of those intercepted controls remains unverified. The final flow used real keyboard interactions without forced clicks or programmatic checked values. [Observed error excerpts](directory-actions-7863/pointer-probe-errors.log) preserve the limitation.

- Phone: [before first view](directory-actions-7863/before-390-viewport.png), [after first view](directory-actions-7863/after-390-viewport.png), [before directory](directory-actions-7863/before-390-directory.png), [after directory](directory-actions-7863/after-390-directory.png).
- Desktop: [before first view](directory-actions-7863/before-1440-viewport.png), [after first view](directory-actions-7863/after-1440-viewport.png), [before directory](directory-actions-7863/before-1440-directory.png), [after directory](directory-actions-7863/after-1440-directory.png).
- [Before receipts](directory-actions-7863/before-receipts.json), [after receipts](directory-actions-7863/after-receipts.json).

This is the remaining directory action follow-up for #7863 and #7844. It does not assess the separate gym-detail criteria. Physical-device behavior remains unverified.
