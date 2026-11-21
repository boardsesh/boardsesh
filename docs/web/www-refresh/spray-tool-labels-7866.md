# Localized spray-wall tool descriptions

The Simplified Chinese spray-wall guide uses a full-width colon (`：`) between each editing tool and its action. The table searched only for ASCII `:`, so all five complete instructions landed in non-wrapping row headers and the action cells were empty. `ToolRow` now finds the first separator of either kind. The existing slice still preserves the complete translated action and the row-header semantics. Catalog copy, surrounding guide sections and media have no source changes.

The regression extends the existing real-resource help test with five cases per shipping locale. It renders the actual spray-wall guide with each route's selected catalog resources, checks five row headers and nonempty action cells, and verifies that each complete original translation is preserved around its separator. The test was committed before the one-line fix. Reinstating the old separator produced exactly five Chinese failures (`expected '' not to be ''`) and 73 passes. Restoring the fix passed all 78 cases in that file. Normal commit hooks and all 65 repository typecheck tasks passed on application source `b4d044757881008f6ef3b51ad223cc1e6daf1d9f`.

## Matched phone evidence

Chromium used a 390 × 900 viewport, the same local runtime, bundled fonts and guide catalogs for both phases. The before phase temporarily used the unchanged table component from base `f4f504253dff167918796b41ca805d2cc7e48549`; the committed fix was restored byte for byte in `finally` before the after phase. Receipts record the actual component hash and source identity.

The English table has five populated action cells in both phases and the document stays 390px wide. The Chinese table changes from zero populated actions and a 410px document to five populated actions and a 390px document. Both languages return HTTP 200 without JavaScript page errors. The existing Chinese first-visit introduction was acknowledged through its real Continue button in each phase. Only the Next development portal and translation-editor controls are hidden in both phases; ordinary page styling is unchanged.

- English: [before phone](spray-tool-labels-7866/before-en-US-phone.png), [after phone](spray-tool-labels-7866/after-en-US-phone.png), [before table](spray-tool-labels-7866/before-en-US-table.png), [after table](spray-tool-labels-7866/after-en-US-table.png).
- Chinese: [before phone](spray-tool-labels-7866/before-zh-CN-phone.png), [after phone](spray-tool-labels-7866/after-zh-CN-phone.png), [before table](spray-tool-labels-7866/before-zh-CN-table.png), [after table](spray-tool-labels-7866/after-zh-CN-table.png).
- [Before receipts](spray-tool-labels-7866/before-receipts.json) and [after receipts](spray-tool-labels-7866/after-receipts.json).

This closes the localized table follow-up to #7866 and #7844. The existing page's route, metadata and indexing classification do not change. Physical-device and screen-reader checks remain unverified.
