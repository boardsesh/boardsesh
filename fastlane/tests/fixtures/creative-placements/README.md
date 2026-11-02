# Live placement responses

Captured on 2026-10-31 using authenticated, GET-only App Store Connect requests.
`default.json` is the English (US) localization of Boardsesh 2.7.0;
`cpp.json` is the English (US) localization of the existing Boardsesh Kilter CPP.
Both endpoints returned HTTP 200. The default response has 40 placements and
includes existing Header and Search Results assignments. The CPP response has
37 placements and includes an existing Search Results assignment.

Each fixture retains the request path, capture time and complete sparse response.
Resource IDs are replaced consistently across both files, including relationship
linkage and resource URLs. No credentials, tokens or signed media URLs are kept.
Sparse fields request placement type, group, state and identity relationships;
included assets contain filenames only and included localizations contain locale.

The regression tests keep Apple's null image/video relationships and ACTIVE
placement state, replacing only IDs needed to bind the synthetic local media.
The reverse library-asset listing mock deliberately returns no placements.
