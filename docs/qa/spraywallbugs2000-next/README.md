# Spray-wall native QA — spraywallbugs2000-next

Actual Boardsesh components rendered in a cached Debug app on the dedicated iPhone simulator. GraphQL and authentication fixtures stayed local. These captures do not establish full production service integration or a matching native fingerprint for the entire app. Published PR OTA checks establish compatibility separately.

| PR | Before | After | Observed result |
| --- | --- | --- | --- |
| #6120 / #6123 | [Look](train-before-look.png) | [Look](train-after-look.png) | Heading clears the native header; counter and portrait controls fit. |
| #6123 | [Spanish counts](train-before-counts-es.png) | [Spanish counts](train-after-counts-es.png) | `1500 presas` fits fully; Publish has its own row. |
| #6125 | [Stationary tap and long press](train-before-no-stationary-commit.png) | [Stationary long press](train-after-stationary-longpress.png) | Baseline stays at two holds; fixed tap then long press gives three then four, once each. |

[Photo wizard](train-after-photo-wizard.png) shows Close, step counter, photo actions, Next and Back. [Spanish no-preview Look](train-after-look-unavailable-localized.png) shows a reachable native selector and counter. [Wizard exit landing](wizard-cancel-preserve.png) records the final home screen. The executed flow verifies Keep going preserves the photo, then a subsequent Close and Leave returns home once.

True multipointer pinch, Apple Pencil/palm hardware, and native cold-start empty-history fallback remain unverified. The portrait caption-overflow report did not reproduce on this specific photo; the fixed controls are visible here.

Baseline: release/next `909fb2a617`. After integration: `8de342a2f5`, containing PR heads #6120 `abfedbbae6`, #6123 `4b8c193483`, and #6125 `8f136bba10`. Later label predicates/comments do not change the photographed output. No temporary fixture adapters are included in fix PRs.

## Main native captures

Main baseline component copies: `064bd3a1d7`; after production integration: `075e573b52`, rendered through QA integration `a2a47e12c9`. Before and after use the same fixture dependency tree, actual ClimbPreviewCard host, native modal, and root ToastProvider. These are component comparisons, not full old/new app binaries.

| PR | Before | After | Observed result |
| --- | --- | --- | --- |
| [#6116](https://github.com/boardsesh/boardsesh/pull/6116) | [Reset review](main-before-reset-review.png) | [Reset review](main-after-reset-review.png) | Summary clears the real modal header; portrait photo and controls fit. |
| [#6113](https://github.com/boardsesh/boardsesh/pull/6113) | [Failed confirmation](main-before-reset-failure.png) | [Repeated failed confirmation](reset-failure-retry.png) | Error appears above Confirm; the existing review and button stay usable. |
| [#6122](https://github.com/boardsesh/boardsesh/pull/6122) | [Climb row](main-before-climb-row.png) | [Climb row](main-after-climb-row.png) | Lost-hold attributes move below the title, giving it more room. |

[Loading state](main-after-reset-loading.png) remains centered below the header. The native failure flow forced two rejected attempts; it did not change ring decisions or verify a successful native commit. Focused tests verify exact payload preservation and successful retry. Main native Leave and unavailable-state flows remain unverified because their fixture lacks required app contexts; focused tests cover those behaviors. No fixture adapters are included in fix PRs.

## Published campaign PRs

| Issue | PR |
| --- | --- |
| #6060 | [#6113](https://github.com/boardsesh/boardsesh/pull/6113) |
| #6039 | [#6114](https://github.com/boardsesh/boardsesh/pull/6114) |
| #6033 | [#6115](https://github.com/boardsesh/boardsesh/pull/6115) |
| #6045, partial | [#6116](https://github.com/boardsesh/boardsesh/pull/6116) |
| #6054, partial | [#6120](https://github.com/boardsesh/boardsesh/pull/6120) |
| #6053, partial | [#6122](https://github.com/boardsesh/boardsesh/pull/6122), [#6123](https://github.com/boardsesh/boardsesh/pull/6123) |
| #6049 | [#6125](https://github.com/boardsesh/boardsesh/pull/6125) |
| #6037 | [#6127](https://github.com/boardsesh/boardsesh/pull/6127) |
| #6052 | [#6128](https://github.com/boardsesh/boardsesh/pull/6128) |

#6051 relies on the other campaign's [#6119](https://github.com/boardsesh/boardsesh/pull/6119), backend deployment, and checking a new edit afterward. Historical missing revisions cannot be recovered. #6123 remains a draft until its #6122 dependency lands. Current readiness is shown on GitHub.

## Photo attribution

The photo in these screenshot derivatives is by **Vivaystn**, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:1%D8%AA%D8%B3%D9%84%D9%82.JPG), licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Source: `ml/holds/fixtures/images/1.jpg`; cropped and annotated with app hold rings. These screenshot derivatives retain that attribution and CC BY-SA 4.0 license. No private user photograph was used.
