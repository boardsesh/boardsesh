# Spray-climb sender counts (#7864, #7865)

The spray stats writer counts each climber with a flash or send once per climb and angle. Repeat sends by the same climber contribute one to this figure (`packages/db/src/queries/climb-stats/recompute.ts`). Following the campaign's source-backed terminology decision, the public summary names the people who logged a send. Both versions of the summary use the page locale for the number and plural form. The server-rendering regression uses fixture counts and the six shipping catalogs.

JavaScript-disabled Chromium captured the [English phone before](screenshots/spray-senders-phone-singular-before.png) and [after](screenshots/spray-senders-phone-singular-after.png) at 390 × 830, and the [French desktop before](screenshots/spray-senders-desktop-grouped-before.png) and [after](screenshots/spray-senders-desktop-grouped-after.png) at 1440 × 850. Each pair uses the same synthetic setter/count fixture and existing guide photograph. The baseline uses the component and translations from `f86ff07440`. No public spray climb was available in the local seed.

## Simplified Chinese follow-up

The profile metadata CI check still expected five language links after Simplified Chinese became the sixth supported locale. The profile returned the correct Chinese URL. Astra recommended listing `/zh-CN/profile/user-1` explicitly in the test so it can independently detect a missing alternate. The test still checks the default alternate and canonical URL.

The design review found that “已有 0 人” read as “already zero people.” Astra recommended the count label “完攀记录人数：” (people who recorded a send) for zero, one and larger numbers. The server-rendering test checks the label with and without a named setter and retains locale grouping for large counts.
