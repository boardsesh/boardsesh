# Design system

Velvet Send tokens, shared components, accessibility, native chrome, motion and maintained design previews.

[All documentation](../README.md)

## Start here

- [AI Design Guidelines — Velvet Send](ai-design-guidelines.md)
- [Mobile chrome and layout metrics](mobile-chrome.md)
- [Mobile motion, haptics and Queue Undo](mobile-motion.md)
- [Velvet Send components](velvet-components.md)

## Guides and supporting records

Current behavior and operational requirements live with their topic. A proposal,
measurement or historical qualification is supporting evidence; its stated limits
and outstanding acceptance gates still apply. A merged change alone does not prove
a production rollout or a physical-device result.

| Document | Path |
| --- | --- |
| [AI Design Guidelines — Velvet Send](ai-design-guidelines.md) | `ai-design-guidelines.md` |
| [Build plans — visual system](build-plans-design.md) | `build-plans-design.md` |
| [Native UI with @expo/ui (mobile)](expo-ui-components.md) | `expo-ui-components.md` |
| [Marketing campaign screenshot provenance](marketing-campaign-assets.md) | `marketing-campaign-assets.md` |
| [Mobile accessibility details](mobile-accessibility.md) | `mobile-accessibility.md` |
| [Mobile chrome and layout metrics](mobile-chrome.md) | `mobile-chrome.md` |
| [Mobile large-screen layout](mobile-large-screen-layout.md) | `mobile-large-screen-layout.md` |
| [Mobile motion, haptics and Queue Undo](mobile-motion.md) | `mobile-motion.md` |
| [Design previews](previews.md) | `previews.md` |
| [Velvet Send components](velvet-components.md) | `velvet-components.md` |
| [Web (consuming Velvet Send)](web-velvet-send.md) | `web-velvet-send.md` |

## Design capture and publication workflow

Browse the [published previews](previews.md). Editable HTML stays here; generated
PNGs live in the public `dev` object-storage bucket and are ignored by Git.

`vp run design:mockups` captures every HTML mockup at 1440px and 390px, uploads each
PNG, verifies its public download checksum, and updates `previews.json` and
`previews.md`. Pass an HTML file or directory after `--` to capture a subset.
`vp run design:publish` publishes already generated local PNGs without recapturing.
Commit the HTML and updated links together.

A full capture removes index entries for deleted or renamed HTML mockups, including
when none remain. Subset captures preserve unrelated entries. `design:publish`
also prunes obsolete links and ignores leftover PNGs without a current HTML source.
The index is written once, after every upload succeeds; stored objects are retained.

Add the variables from `.env.dev-artifacts.example` to the repository root's
ignored `.env.local`, then fill in the dev bucket credentials. Existing process variables take precedence.
These commands use only `DEV_*` storage variables, never production media credentials.
The S3 client sends no ACL header. Content-hashed object keys keep shared links stable.

Only public design PNGs under this directory are accepted. Store captures and
recorded backend fixtures keep their existing capture pipeline.
