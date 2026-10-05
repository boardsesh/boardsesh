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

## Photo attribution

The photo in these screenshot derivatives is by **Vivaystn**, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:1%D8%AA%D8%B3%D9%84%D9%82.JPG), licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Source: `ml/holds/fixtures/images/1.jpg`; cropped and annotated with app hold rings. These screenshot derivatives retain that attribution and CC BY-SA 4.0 license. No private user photograph was used.
