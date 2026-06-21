# Achievements System Plan

**Status:** Draft proposal — 2026-05-12 (rev. 2)
**Owner:** TBD
**Source data:** Read-only analysis of prod Postgres (snapshot 2026-05-12)

---

## 0. Changelog from user feedback

Three pieces of feedback from the first draft drove these changes:

- _"While the same climb should only count once, mirrored climbs should count separately from their original — the same hold pattern feels very different on the other side."_ → Per-climb dedup is now keyed on `(climb_uuid, is_mirror)`, not just `climb_uuid`. Sending a V8 normally and the same V8 mirrored gives full V-points credit for both. Same change applies to `grade.repeat` (mirror counts as a separate send) but **not** to `grade.first` — the grade is the grade, you only "first V8" once. See §4.1.1 and §4.4.
- _"Would be fun to see my stats across angles"_ / _"Performance and grade distribution are quite different at some angles, would be great to see/track."_ → Added a per-angle stats surface (§7.7) and a small set of angle achievements (§4.5.1) calibrated against prod (avg max grade on Kilter ranges from V3 at 0° to V7 at 40-50° back down to V5 at 70°).
- _"Excited that you're thinking about it from a climber-who-wants-to-improve POV, rather than board-seller."_ → Reinforced in §2 principle 1; no scope change beyond the explicit wording.

---

## 1. Why we're building this

The hardware boards and Aurora's stock app both treat climbing as a sequence of disconnected sends. Boardsesh already has a richer object — the explicit **session** — and a session feed where users can vote, comment, and follow each other. Achievements turn that feed into something users want to come back to: a personal record of progress that surfaces _during_ a session and gets shared _after_ it.

Concretely, achievements should:

1. Make the in-app session experience feel like more than a logger — climbers leave with something to show for the day even if nothing dramatic happened.
2. Give the social feed durable, discrete moments to share (a "first V8" card beats "logged 12 climbs").
3. Pull lapsed climbers back. A weekly rhythm achievement that's almost-complete is a gentler nudge than a notification.
4. Reward exploration the stock Kilter app can't see — angle variety, multi-board use, projecting, comeback sessions.

**Non-goals:**

- A point/XP economy or leaderboard. We don't want to optimize for whales or invite cheating via fake ticks.
- Aurora-style "training plan" prescriptions. Achievements describe what happened, they don't dictate what to do.
- Anything that requires synchronous heavy computation on the hot path. Achievement evaluation must never block tick save.

---

## 2. Design principles

These exist because the prod data analysis (§3) showed each of them mattering:

1. **Calibrate to the median user, not the power user.** P50 user has 84 lifetime ticks and 39 lifetime sessions. The first achievement tier must unlock fast — within a session or two — or 70% of users will never see one fire. **The frame is climber-improvement, not board-marketing**: every achievement should answer "what does this tell a climber about how they're progressing?" — not "which feature of the product do we want them to use more?" If we can't articulate the climber-improvement story for an achievement in one sentence, cut it.
2. **Streaks are weeks, not days.** Only **22 users have ever had a 5-day climbing streak**, and 5 users a 7-day streak. Climbers rest. Use _sessions per calendar week_ (a much more reachable signal: 252 users have logged 3+ sessions in a single week).
3. **Aurora-imported flash counts are unreliable.** 70% of all ticks have status=`flash`, vs 16% `send`, 14% `attempt`. This is because Aurora's data import treats default ascents as flashes. **Scope flash-based achievements to ticks that originated in Boardsesh** (or to the most recent N days where users are actively logging the difference) — otherwise we hand "Flash Master" badges to anyone with a synced history.
4. **Reward grinding, not just sending.** 7,074 sessions contain a send of a climb the user previously attempted in a different session — that "I came back and got it" moment is core to bouldering and almost no app honors it.
5. **Stable IDs, idempotent awards.** Every achievement award must be replayable. Explicit sessions already have durable UUIDs; evaluators must use those ids to recompute history without dupes.
6. **No notification spam.** A user who imports years of Aurora history will trigger hundreds of achievements. The first computation per user is silent (or a single "Welcome to your achievements" digest); only achievements earned _after_ enrollment fire notifications.
7. **Session-bound first, lifetime second.** Most awards should resolve at session close so the session detail page is the natural celebration surface. Lifetime/cross-session awards are a smaller secondary set.
8. **Boring names, generous criteria.** "First V6" is fine. Avoid the gamification voice ("LEGENDARY!" "BEAST MODE!"). Match the existing CLAUDE.md copy guidance.

---

## 3. What the data says

All numbers from prod snapshot 2026-05-12.

### 3.1 Population

| Metric                       | Count           |
| ---------------------------- | --------------- |
| Users (table)                | 1,007           |
| Users with ≥1 tick           | 574             |
| Active last 7d / 30d / 90d   | 169 / 356 / 542 |
| Total ticks                  | 252,891         |
| Historical inferred sessions | 34,530          |
| Party (board) sessions       | 1,559           |

The historical inferred-session count is from the pre-removal production analysis only. New achievement work should use explicitly-created `board_sessions` rows; solo ticks are not auto-grouped into sessions.

Tick volume is heavily long-tailed:

| Bucket    | Users | Total ticks |
| --------- | ----- | ----------- |
| <10       | 162   | 627         |
| 10–49     | 89    | 1,962       |
| 50–99     | 51    | 3,805       |
| 100–499   | 134   | 37,476      |
| 500–999   | 62    | 46,187      |
| 1000–4999 | 73    | 142,242     |
| 5000+     | 3     | 20,593      |

P50 = 84 ticks, P90 = 1,275, P99 = 3,998, max = 7,960.

### 3.2 Session shape

- Median historical session: **5 unique climbs, 7 ticks, 40 minutes**.
- P90 historical session: 14 climbs, 113 minutes.
- Median user has 39 lifetime sessions, P90 has 205, max = 631.
- **Multi-board sessions are essentially nonexistent** (5 / 34,530). Multi-board exploration achievements will be aspirational/niche, not core.
- **Party mode is mostly used solo** (avg 1.04 distinct participants per party session, max 3, only 90 named, only 16 with a goal). Don't over-index on party-only achievements.

### 3.3 Climb status mix

| Status  | Count   | Note                                    |
| ------- | ------- | --------------------------------------- |
| flash   | 176,065 | 70% — heavily inflated by Aurora import |
| send    | 41,711  | 16%                                     |
| attempt | 35,116  | 14%                                     |

Repeat behaviour per (user, climb) pair:

- 105,008 climbs touched once
- 37,342 with 2–5 attempts
- 6,031 with 6–20 attempts
- 318 with 20+ attempts
- **2,548 climbs sent after >10 cumulative attempts**, 97 after 50+, 14 after 100+.

### 3.4 Grades

Distribution of each user's hardest sent grade on Kilter:

| Hardest grade | Users |
| ------------- | ----- |
| ≤ V2          | 21    |
| V3            | 26    |
| V4            | 32    |
| V5            | 51    |
| V6            | 37    |
| V7            | 46    |
| V8            | 104   |
| V9            | 49    |
| V10           | 23    |
| V11+          | 33    |

Useful for tiering: V6 is roughly the median ceiling, V8 is the bulge, V10+ is rare.

### 3.5 Boards & angles

- Kilter 225,789 (89%), Tension 26,482 (10%), Decoy 554, MoonBoard 56, Grasshopper 11.
- **45 users have logged on 2 boards, 4 on 3+**. Multi-board achievements will land for ~10% of the active base.
- 40° is the dominant angle (108k ticks), then 50° (34k) and 30° (27k).
- **266 of 574 users (46%) are angle loyalists** (>80% of ticks on one angle). Angle-variety achievements have real headroom.

### 3.6 Rhythm

Day-of-week peaks Tuesday > Wednesday > Monday; weekend dips. Hour-of-day double peak at 10–13 and 17–20 — gym schedule. **PR sessions: 1,166** (sessions where the user hit their lifetime hardest send).

### 3.7 V-points (a.k.a. "session score")

Sum of V-grade values for sends in a session — the metric a lot of climbers already informally track ("100 V-points day"). With the half-grade rule (§4.1.1) and per-(climb, orientation) dedup, the prod data says:

- Median session V-points: **19**, P75=37, P90=61.5, P99=126.
- Top solo session ever: **420 V-points**. Zero solo sessions have cleared 500.
- 854 sessions ever (2.5%) have hit 100 V-points. **Only 69 distinct users ever**.

The headline insight: 100 V-points is a real stretch goal for an individual (top 12% of active tickers have ever done it once), but trivially reachable for a crew. A 5-person session at average solo P90 (≈62 each) is 310 V-points; 10 people at P50 (≈19 each) is 190 V-points; 10 people pushing for 100 each is the explicit "1000 V-points crew session" Platinum tier.

### 3.8 Mirror climbing

`boardsesh_ticks.is_mirror` flags ticks done with the climb mirrored left↔right. The data tells a sharp story:

- **6,934 mirror ticks** out of 253k total (~2.7%); 6,152 of those are sends/flashes.
- **Mirror is essentially a Tension Board feature**: 6,084 of 6,152 mirror sends are on Tension, 61 on Decoy, 7 on Grasshopper, **0 on Kilter, 0 on MoonBoard**. Tension is symmetric and the mirror function is core to how it's used; on Kilter the feature exists but climbers don't reach for it.
- **40 users have ever mirrored** (7% of active tickers). 539 have never mirrored. Among the 40 who do, it's serious: top user has 3,591 mirror sends, 7 users have 100+.
- **3,883 climbs have been sent both normally and mirrored** by 37 distinct users — the "ambidextrous" cohort. Per-user counts: 37 with ≥1 both-ways send, 22 with ≥10, 8 with ≥50, 3 with ≥200 (top is 1,984).
- **720 sessions** mix mirror and normal sends (≥3 of each); **75 sessions are pure mirror** — niche flex, advertise as legendary.
- Hardest mirror grade per user: 20 users have mirror-sent V6+, 9 V8+, 6 V9+, **2 V10+**.

The audience is small, devoted, and overlapping with the Tension power-user base. Mirror achievements should _celebrate_ that minority rather than try to convert the majority — frame them as "Tension Mirror" badges, with the implicit message that this is a real training discipline.

### 3.9 Beta videos and the supply gap

`board_beta_links` carries the catalog of community beta videos. The recently-added `created_by_user_id` column attributes each new submission to a climber.

- 45,796 beta links in the system today, **0 with user attribution** (all imported from Aurora/IG bulk-scrape before the column existed).
- 16,802 unique climbs have at least one beta video.
- **23,630 climbs are sent regularly by tracked users but have no beta video at all.** Of those, 10,150 have ≥2 sends, 2,705 have ≥5 sends, 1,132 have ≥10 sends.

That last bullet is the supply gap — climbers want beta on these, the data proves it, and nobody's posting yet. Achievement design should aggressively reward filling that gap (see §4.7).

---

## 4. Achievement taxonomy

We split by **scope** (when/where it resolves) and **family** (what it's about). All awards resolve to a single canonical event with a stable ID; the same achievement can fire at multiple tiers (Bronze → Silver → Gold → Platinum) without distinct definitions.

### 4.1 Session achievements (resolve at session close)

These fire when an explicit session closes. They appear inline on the session detail page and become shareable feed cards.

| ID                          | Name              | Trigger                                                                             | Calibration                                                |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `session.first_send`        | First send        | Any send/flash in this session, only when the user has 0 prior sessions             | Universal                                                  |
| `session.send_count.{n}`    | Volume            | Tiers at 5 / 10 / 20 / 30 sends in one session                                      | T1=57% sess, T4=1%                                         |
| `session.flash_count.{n}`   | Flash run         | 3 / 5 / 10 in-app flashes in one session (Aurora ticks excluded)                    | TBD post-launch                                            |
| `session.pr_session`        | New personal best | Session contained a send at the user's all-time hardest grade                       | 1,166 historical                                           |
| `session.redpoint`          | Stuck the project | Sent a climb in this session that you'd attempted in an earlier session             | 7,074 historical                                           |
| `session.long_haul`         | Long session      | ≥120 minutes between first and last tick                                            | ~10% of sessions                                           |
| `session.angle_explorer`    | Angle hop         | ≥3 distinct angles in one session                                                   | Niche                                                      |
| `session.board_hop`         | Two-board day     | ≥2 board types in one session                                                       | Very rare (5 historical) — keep but advertise as legendary |
| `session.with_a_friend`     | Logged together   | Explicit session has another participant                                            | Computable from session participants                       |
| `session.v_points.{n}`      | V-point session   | Sum of V-grades sent in one session — tiers at 25 / 50 / 100 / 200                  | See §4.1.1 — 100 V-points has been hit by 72 users ever    |
| `session.crew_v_points.{n}` | Crew V-points     | Sum of V-grades across **all participants** in one session — 100 / 250 / 500 / 1000 | See §4.1.1 — Gold (1000) requires a real crew              |

#### 4.1.1 V-points — calibration & rules

V-points are the climbing equivalent of "stage points" in cycling: each send/flash is worth its V-grade in points. Attempts don't count. The metric is famous in friend groups (one of our users routinely chases "100 V-points in a session") and converts perfectly into a multiplayer goal — gather a crew and the same number becomes reachable for everyone, not just the strongest climber.

**Scoring rule** (defined per row of `board_difficulty_grades`):

- V0 climbs are worth 0. They count toward send count, not V-points (so logging 50 jugs doesn't farm a tier).
- Plain V-grades (no French "+") are worth their integer: V1=1, V3=3, V6=6, V9=9, V11=11.
- Half-grades — French grades with a "+" suffix that share their V-integer with the previous grade — are worth +0.5: **V3+=3.5, V4+=4.5, V5+=5.5, V8+=8.5**. These exist on the Aurora boards because Aurora flattens 6a/6a+ both to V3, 6b/6b+ both to V4, 6c/6c+ both to V5, 7b/7b+ both to V8 — but climbers genuinely think of the "+" as harder, and we honour that.
- French "+" suffixes where the V-integer already bumps (7a→7a+ goes V6→V7, 7c→7c+ goes V9→V10) get no extra increment — the bump is already priced in.

That gives a clean mapping (Kilter, same shape on Tension):

| French | V-display | V-points |
| ------ | --------- | -------- |
| 5a/5b  | V1        | 1        |
| 5c     | V2        | 2        |
| 6a     | V3        | 3        |
| 6a+    | V3+       | 3.5      |
| 6b     | V4        | 4        |
| 6b+    | V4+       | 4.5      |
| 6c     | V5        | 5        |
| 6c+    | V5+       | 5.5      |
| 7a     | V6        | 6        |
| 7a+    | V7        | 7        |
| 7b     | V8        | 8        |
| 7b+    | V8+       | 8.5      |
| 7c     | V9        | 9        |
| 7c+    | V10       | 10       |
| 8a     | V11       | 11       |
| 8a+    | V12       | 12       |
| 8b/+   | V13/V14   | 13/14    |

Calibration from prod (33,534 sessions with ≥1 send, applying half-grades + per-(climb, orientation) dedup):

| Tier (per user, per session) | V-points | Sessions ever | Users ever                  |
| ---------------------------- | -------- | ------------- | --------------------------- |
| Bronze                       | 25       | 13,556 (40%)  | 274 (48% of active tickers) |
| Silver                       | 50       | 5,117 (15%)   | 187 (33%)                   |
| Gold                         | 100      | 854 (2.5%)    | 69 (12%)                    |
| Platinum                     | 200      | 30 (0.09%)    | 13                          |

Top solo session ever recorded: **420 V-points** (zero solo sessions have ever cleared 500). Distribution: P50=19, P90=61.5, P99=126. The mirror-as-separate rule shifts the totals very slightly (mirror is rare even among the cohort that does it), but the principle is right.

Crew V-points (multi-user, summed across everyone in the same session) tier at 100 / 250 / 500 / 1000. Gold (500) is reachable for ~5 strong climbers or a larger mixed crew; Platinum (1000) needs ~10 friends ganging up — explicitly the headline scenario this achievement is designed to enable.

Implementation notes:

- **Per-user evaluator** runs at session close. Reads ticks where `session_id` matches and `status IN ('send','flash')`, joins to `board_difficulty_grades`, applies the scoring rule above (look up `v_points` from a derived view computed once at startup from `board_difficulty_grades`), sums after per-climb dedup.
- **Crew evaluator** runs against `board_sessions` at close, summing across `boardsesh_ticks` for every distinct `user_id` in that session.
- **Cap per climb-orientation = once per session.** Repeating the same climb 5 times in one session counts the V-grade once. **But normal and mirror count as separate climbs** — sending V8 normally then sending the same V8 mirrored credits 16 V-points (or 8.5+8.5 for V8+), not 8. Per direct user feedback: "even though it's the same hold pattern, climbs can feel very different on one side compared to the other." Implement as `SELECT DISTINCT (user_id, session_id, climb_uuid, COALESCE(is_mirror, false))` before summing.
- **Crew dedup.** If two users both sent V8 of the same climb in a crew session, both their points count — different bodies, different sends. Only the per-user dedup applies.
- **Display.** Show as integer when whole (`100 V-points`), one decimal when fractional (`5.5 V-points` for a single V5+ send). Never round to integer in storage — half-points compound (10× V5+ sessions = 55 V-points exactly, not 50).

UI: V-points become a first-class number on the session summary, alongside Sends/Attempts/Duration. The crew variant only renders when `participant_count > 1`. We also surface the live count in the session detail header during an active party session ("Crew: 247 V-points") so the goal-chasing dynamic works in real time, not just post-hoc.

### 4.2 Lifetime / cumulative achievements

Resolve whenever the running total crosses a threshold. Computed on each tick save _and_ on session close.

| Family               | Tiers (count)                     | Notes                                                                             |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Total sends          | 10 / 50 / 100 / 500 / 1000 / 5000 | Reachable by all tiers (P50 user has 84 ticks → first two tiers feasible).        |
| Distinct climbs sent | 25 / 100 / 500 / 1000 / 2500      | P90 user has 714 distinct climbs.                                                 |
| Sessions logged      | 1 / 10 / 50 / 100 / 250 / 500     | Median 39 → first three tiers reachable in a season.                              |
| Hours on the wall    | 5 / 25 / 100 / 500                | Sum of (lastTickAt − firstTickAt) per session. Excludes single-tick sessions.     |
| Hardest grade        | One award per V-grade unlocked    | "First V3", "First V4" … one row per (user, grade, board_type).                   |
| Total V-points       | 100 / 1k / 10k / 50k / 100k       | Lifetime sum across all sends. P90 user (~714 distinct climbs at avg V5) ≈ 3,500. |

### 4.3 Rhythm / streak achievements (week-based)

| ID                      | Trigger                                            | Reachable by today         |
| ----------------------- | -------------------------------------------------- | -------------------------- |
| `rhythm.weekly_x3`      | 3 sessions in a single ISO week                    | 252 users (~44% of active) |
| `rhythm.weekly_x4`      | 4 sessions in a single ISO week                    | 147 users (~26%)           |
| `rhythm.month_active`   | ≥1 session in 4 consecutive ISO weeks              | TBD                        |
| `rhythm.comeback`       | First session in ≥30 days after a previous session | High recall, high meaning  |
| `rhythm.year_in_review` | Annual auto-summary on user's account anniversary  | Triggered yearly           |

We deliberately do **not** ship a "7-day streak" achievement because only 5 users have ever earned it. Day-streaks reward people who don't rest, which is bad climbing advice.

### 4.4 Grade & projecting achievements

| ID                   | Trigger                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `grade.first.{V}`    | First send at each V-grade _and each half-grade_ (per board_type) — `V5` and `V5+` are separate awards |
| `grade.flash.{V}`    | First flash at each V-grade and half-grade (in-app ticks only, see §2 principle 3)                     |
| `grade.repeat.{V}`   | 10 / 50 sends at the same V-grade or half-grade — "Solid at V6", "Solid at V5+"                        |
| `project.long_grind` | Sent a climb after ≥10 cumulative attempts                                                             |
| `project.epic_grind` | Sent a climb after ≥50 attempts                                                                        |
| `project.spite_send` | Sent a climb 30+ days after first attempt                                                              |

The `{V}` variant uses the V-display form from §4.1.1 (`V1`, `V2`, …, `V3+`, `V4+`, `V5+`, `V8+`). On the boards we ship today this means up to 22 distinct first-send awards per board_type (Kilter has 39 grade rows but they collapse to V0 through V22, with the four half-grades adding extra awards at V3+/V4+/V5+/V8+). We use the V-display form (not the French grade) because it's what climbers in friend groups actually say out loud.

**Mirror rule** (per user feedback): `grade.first.{V}` fires once per grade — sending V8 normally and V8 mirrored is one "first V8". The grade is the grade. But `grade.repeat.{V}` counts mirror as a separate send: a normal V6 + mirror V6 of the same climb counts 2/10 toward Solid-at-V6, because they're different physical efforts. Same dedup unit as V-points: `(user_id, climb_uuid, COALESCE(is_mirror, false))`.

### 4.5 Exploration achievements

| ID                      | Trigger                                         |
| ----------------------- | ----------------------------------------------- |
| `explore.angles_5`      | Sent climbs at 5 distinct angles                |
| `explore.angle_extreme` | Send at angle ≥60° **and** ≤20°                 |
| `explore.boards_2`      | Logged on 2 board types (Kilter + Tension etc.) |
| `explore.boards_3`      | Logged on 3 board types                         |
| `explore.layouts_3`     | Logged on 3 distinct layout/size combos         |
| `explore.benchmark_set` | Sent the full benchmark set at a given grade    |

#### 4.5.1 Angle-stratified achievements (per user feedback)

Two users specifically asked for angle stats — _"performance and grade distribution are quite different at some angles, would be great to see/track."_ The prod data confirms it: average max grade on Kilter is V3 at 0° (slab), climbs to **V7 at 40-50°**, then drops back to V5 at 70°. There's a real story per user that the current `you/progress` page doesn't tell.

The headline deliverable is the **per-angle stats surface** (§7.7), not the achievements — but a small set of achievements anchors the surface and gives users something to chase per angle.

| ID                           | Trigger                                                                                   | Reachability today                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `angle.specialist.{angle}`   | 50 sends at one angle — your "home" angle (variant = `40`, `50`, etc.)                    | 40° has 475 users; specialist tier is plausibly hundreds            |
| `angle.steep_specialist`     | 25 / 100 sends at angle ≥50° (steep)                                                      | 134 / 65 users today                                                |
| `angle.slab_specialist`      | 25 / 100 sends at angle ≤25° (slab)                                                       | 85 / 33 users today                                                 |
| `angle.versatile_v6`         | Sent V6+ at 3 / 5 / 7 distinct angles                                                     | 185 / 121 / 61 users today                                          |
| `angle.full_spectrum`        | Sent at every angle the layout/size has set                                               | Niche, layout-aware — Bronze of "send it everywhere"                |
| `angle.balanced_pyramid`     | Sent at least 5 climbs at each of 3+ different angles, ≥V3 each                           | Rewards real cross-training, not just one-and-done                  |
| `grade.angle_pr.{angle}.{V}` | New PR at a _specific_ angle (e.g. "V7 at 50°" was harder than your previous best at 50°) | Generated lazily — many users have already done this once per angle |

`grade.angle_pr` is the most novel one: it acknowledges that hitting V7 at 30° is a different milestone from hitting V7 at 50°, and rewards both. We compute it the same way as `grade.first.{V}` but partitioned by angle. This is the achievement form of the angle-stats surface — every PR per angle gets its moment.

Variant naming: `angle.specialist.40`, `angle.versatile_v6` (no variant — uses `tier` for 3/5/7), `grade.angle_pr.40.V7` etc.

### 4.6 Social achievements

These align with the existing social tables (`comments`, `feed_items`, `board_follows`, `board_sessions`):

| ID                      | Trigger                                              |
| ----------------------- | ---------------------------------------------------- |
| `social.first_follow`   | Followed your first climber                          |
| `social.crew_session`   | Session has ≥3 distinct participants                 |
| `social.commenter`      | Posted a comment on 5 different climbs               |
| `social.first_party`    | Created your first party-mode session                |
| `social.public_session` | Made a discoverable session that someone else joined |

### 4.7 Beta video contributor achievements

`board_beta_links.created_by_user_id` was added recently — every new beta video posted in-app now carries the climber who shared it. This unlocks a contributor track that rewards the people who actually fill the beta gap.

The data state today (snapshot 2026-05-12):

- 45,796 beta links exist, **0 currently attributed to a user** (all imported from Aurora/IG without attribution).
- 16,802 unique climbs have at least one beta video.
- **23,630 climbs have been sent by tracked users but have no beta video yet** — that's the supply gap. 10,150 of those have ≥2 sends, 2,705 have ≥5 sends, **1,132 have ≥10 sends and zero beta**.

These tiers can't be calibrated against historical data (the column is empty). Initial thresholds are conservative; recalibrate at 30/90 days post-launch using the SQL in Appendix B.

| ID                     | Trigger                                                                                        | Why it matters                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `beta.first_share`     | Posted your first attributed beta video                                                        | Onboarding moment                                                         |
| `beta.contributor.{n}` | 5 / 25 / 100 / 500 beta videos posted                                                          | Volume tier                                                               |
| `beta.first_on_climb`  | You posted the first beta video for a climb (the row's PK was previously empty for that climb) | **23k climbs eligible today** — highest-impact contribution               |
| `beta.fills_demand`    | Posted beta on a climb with ≥5 prior sends and no prior beta                                   | 2,705 climbs eligible — these are the ones people are actively looking up |
| `beta.from_the_source` | Posted beta on a climb you've personally sent                                                  | "I climbed it, here's how" — the credible-source moment                   |
| `beta.hard_send.{V}`   | Posted beta on a climb at V8 / V10 / V12 that you've sent                                      | Rewards the rare voices on hard projects                                  |
| `beta.benchmark`       | Posted beta on a benchmark climb (`is_benchmark=true`)                                         | Benchmarks are the most-attempted climbs in the catalog                   |
| `beta.session_share`   | Posted a beta video for a climb you sent in the last 24h                                       | Session-scope — fires on the session detail page                          |

Implementation notes:

- Trigger: `beta_link_created` — a new event fired by the resolver/route that inserts into `board_beta_links`. Payload = full row.
- `beta.first_on_climb` evaluator: `SELECT COUNT(*) FROM board_beta_links WHERE board_type=$1 AND climb_uuid=$2` _excluding the just-inserted row_. If 0, fire. Idempotent because the unique award row keys on `(user_id, achievement_id, variant=climb_uuid)`.
- `beta.from_the_source` evaluator: `EXISTS` query against `boardsesh_ticks` with the same user/climb/board and `status IN ('send','flash')`. The data already has the index `boardsesh_ticks_climb_idx` to support this cheaply.
- `beta.fills_demand` evaluator: count prior sends on the climb (`boardsesh_ticks` with same climb_uuid + board_type + status in send/flash) and prior beta links. Fires on the threshold cross.
- **No backfill** for any beta achievement — the column is empty before today, so backfill would award nothing. Run the evaluators forward-only.
- **Quality gate.** A future open question (§9) — do we wait for view counts or upvotes before awarding `beta.contributor.500`? For v1, no — the social cost of spamming junk videos to a friend graph is enough deterrent. Revisit if it becomes a problem.

### 4.8 Mirror climbing achievements

Driven by `boardsesh_ticks.is_mirror`. See §3.8 for the data — almost all activity is on Tension Board, by ~40 dedicated users. Tiers are calibrated tight because the population is small; "mirror your first climb" is meaningful here in a way "send your first climb" isn't.

| ID                        | Trigger                                                                 | Reachability today                              |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `mirror.first_send`       | First send/flash with `is_mirror=true`                                  | 40 users have already done this                 |
| `mirror.contributor.{n}`  | 5 / 25 / 100 / 500 mirror sends total                                   | T1≈24, T2≈15, T3≈7, T4=1 user today             |
| `mirror.both_ways.first`  | First climb sent both normal AND mirrored                               | 37 users today                                  |
| `mirror.both_ways.{n}`    | 10 / 50 / 200 climbs sent both ways                                     | 22 / 8 / 3 users today (top 1,984)              |
| `mirror.hard.{V}`         | Mirror send at V6 / V8 / V10                                            | 20 / 9 / 2 users today                          |
| `mirror.symmetric_grade`  | Sent your lifetime hardest grade both normally and mirrored             | Rare flex — true two-sided strength             |
| `session.mirror_balanced` | Session with ≥3 mirror sends AND ≥3 normal sends — "trained both sides" | 720 historical sessions                         |
| `session.full_mirror`     | Session where 100% of sends are mirrored (≥3 sends)                     | 75 historical — keep but advertise as legendary |

Implementation notes:

- **Trigger:** lifetime mirror evaluators run on `tick_saved` when the saved tick has `is_mirror=true` and `status IN ('send','flash')`. Session-scope evaluators run on `session_closed`.
- **Both-ways evaluator:** for the just-saved mirror send, check `EXISTS` for a non-mirror send by the same (user, board_type, climb_uuid). The `boardsesh_ticks_climb_idx` and `boardsesh_ticks_user_climbed_at_idx` cover this in <5ms.
- **Symmetric grade evaluator:** lazily recomputes the user's PR grade on each tick save. If the new tick is at-or-above their current PR and is mirrored (and a non-mirror send at that grade exists), or vice versa, fire.
- **Cross-board variant:** `mirror.both_ways` and `mirror.hard` use `:tension`, `:decoy`, `:grasshopper`, etc. as variant suffixes (mirror is empty on Kilter/MoonBoard today, so we don't list those tiers but they're cheap to support if the data ever shifts).
- **No backfill suppression discount.** Unlike most lifetime evaluators, the mirror cohort is small enough that backfilling silently is the right move — the 40 users get their tiers awarded with `granted_at=now`, `earned_at=historical`, no feed/notification side effects (per §6.4). On the next mirror send post-enrollment, normal celebration kicks in.

Copy notes (per CLAUDE.md voice): keep the language plain. "Sent it both ways" reads better than "Symmetry Master." For the full-mirror session, "Mirror only" beats "MIRROR MODE!"

### 4.9 Hidden / easter-egg achievements

Small, opt-out, never-loud. A few examples:

- `hidden.crack_of_dawn` — session starting between 04:00–06:00 local (5,914 ticks happen at 03:00 — early-bird crowd exists).
- `hidden.tuesday_loyalist` — 10 sessions on a Tuesday (Tuesday is the most-climbed day in the data).
- `hidden.midnight_send` — send recorded between 23:00 and 02:00.

Display these without the criteria spelled out; they show up in the user's collection only after firing.

---

## 5. Schema design

### 5.1 New tables

```sql
-- Static catalog of achievement definitions. Kept in code (TS file)
-- and synced into this table at startup so UI/queries can JOIN against it.
-- Tiers live in a single row using a JSONB array for thresholds.
CREATE TABLE achievement_definitions (
  id              TEXT PRIMARY KEY,            -- e.g. 'session.send_count'
  family          TEXT NOT NULL,               -- 'session' | 'lifetime' | 'rhythm' | 'grade' | 'explore' | 'social' | 'beta' | 'mirror' | 'hidden'
  scope           TEXT NOT NULL,               -- 'session' | 'lifetime' | 'periodic'
  display_name    TEXT NOT NULL,               -- i18n key, not raw text
  description_key TEXT NOT NULL,
  hidden          BOOLEAN NOT NULL DEFAULT false,
  tier_thresholds JSONB,                       -- e.g. [5,10,20,30] for tiered counts
  metadata        JSONB,                       -- evaluator config, icon hints
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- One row per (user, achievement, tier). Idempotent: UNIQUE constraint.
CREATE TABLE user_achievements (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id        TEXT NOT NULL REFERENCES achievement_definitions(id),
  tier                  INT NOT NULL DEFAULT 1, -- 1=bronze, 2=silver, 3=gold, 4=platinum
  earned_at             TIMESTAMP NOT NULL,    -- the *climb* time, not the compute time
  granted_at            TIMESTAMP NOT NULL DEFAULT now(),
  -- Provenance: which session/tick caused this award. Enables "view the moment".
  source_session_id     TEXT,                  -- board_sessions.id
  source_tick_id        BIGINT REFERENCES boardsesh_ticks(id) ON DELETE SET NULL,
  -- Per-grade / per-board specifiers stored here so 'grade.first.V6.kilter'
  -- and 'grade.first.V6.tension' are different rows of the same definition.
  variant               TEXT,                  -- e.g. 'V6', 'V6:kilter'
  -- Snapshot of the relevant counter at award time, for display.
  metric_value          INT,
  CONSTRAINT user_achievements_unique
    UNIQUE (user_id, achievement_id, tier, COALESCE(variant, ''))
);

CREATE INDEX user_achievements_user_idx
  ON user_achievements (user_id, granted_at DESC);
CREATE INDEX user_achievements_session_idx
  ON user_achievements (source_session_id);
CREATE INDEX user_achievements_feed_idx
  ON user_achievements (granted_at DESC);
```

Notes:

- `achievement_definitions` is a thin DB mirror of a TS catalog (`packages/shared-schema/src/achievements/catalog.ts`). The catalog is the source of truth — the table exists so `feed_items` and Postgres-side queries can JOIN cleanly.
- `earned_at` is the climb time (the wall-clock moment the achievement _would have_ unlocked), `granted_at` is when our evaluator wrote the row. They diverge during backfill.
- Tier is a small int rather than per-tier rows-with-different-IDs because it makes "show me my highest tier per achievement" a one-line query.

### 5.2 Reuse existing rows

We do not need new aggregate columns on sessions; session-scope evaluators can compute from `boardsesh_ticks.session_id`. For lifetime achievements, we recompute the relevant counter at evaluation time (cheap with the existing `boardsesh_ticks_user_climbed_at_idx` index).

### 5.3 Feed/notification integration

Achievements get a new `feed_item_type` value (`'achievement'`) and a new `social_entity_type` (`'achievement'`). When an achievement is granted post-enrollment, we:

1. Insert a `feed_items` row recipient = followers of the user, entity = the `user_achievements.id`.
2. Insert a `notifications` row to the user themselves (read-once, like ticks).
3. Hide all of the above when the achievement is from backfill (see §6.4).

---

## 6. Computation architecture

### 6.1 Evaluator interface

```ts
// packages/backend/src/achievements/evaluators/types.ts
export type AchievementContext = {
  user: { id: string; createdAt: Date };
  trigger:
    | { kind: 'tick_saved'; tick: Tick }
    | { kind: 'session_closed'; session: BoardSession }
    | { kind: 'periodic'; weekStart: Date };
  // Read-only DB handle. Evaluators query freely; the framework enforces
  // a per-evaluator timeout and short-circuits on failure.
  db: ReadOnlyDb;
};

export type EvaluatorResult = {
  achievementId: string;
  tier: number;
  variant?: string;
  earnedAt: Date;
  metricValue?: number;
  sourceSessionId?: string;
  sourceTickId?: number;
};

export type Evaluator = {
  id: string;
  triggers: Array<'tick_saved' | 'session_closed' | 'periodic'>;
  evaluate(ctx: AchievementContext): Promise<EvaluatorResult[]>;
};
```

Each evaluator owns one definition (or one family of tiers). They're pure functions of context plus DB reads, return zero or more "I should have this" results, and the framework writes `user_achievements` rows with `ON CONFLICT DO NOTHING`. Idempotency falls out of the unique constraint.

### 6.2 Trigger points

| Trigger          | Where                                       | Evaluators run                                                                        |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tick_saved`     | `saveTick` in backend after the tick commit | Lifetime counters, grade firsts, projecting wins                                      |
| `session_closed` | When an explicit session ends               | Session-scope evaluators (volume, PR, redpoint, long_haul, angle_explorer, board_hop) |
| `periodic`       | Daily cron, end of week / month / year      | Rhythm achievements, year-in-review                                                   |

Evaluation never blocks tick save — it runs after the transactional write is committed, in a fire-and-forget queue (existing pattern: see how feed/notification writes already work). A failure logs and retries on the next trigger but never bubbles back to the user request.

### 6.3 Performance budget

- Per-tick evaluation budget: **50 ms wall** for all evaluators combined. Lifetime counters that need a full-table scan must use the existing `boardsesh_ticks_user_climbed_at_idx` (already exists, hits within ~5 ms even for the heaviest user with 7,960 ticks).
- Per-session evaluation budget: **200 ms**, since this runs out-of-band.
- All evaluators must be expressible as Drizzle queries (per CLAUDE.md). No raw SQL unless a CTE or window function is genuinely required.

### 6.4 Backfill & enrollment

When a user first gains an account or imports Aurora data:

1. Mark them as `enrolled_at = now()` in a `user_achievement_settings` row.
2. Walk their full history once, oldest-first, running session-close + lifetime evaluators against each closed session. Write all earned rows with `granted_at = now()` but `earned_at = (the historical session date)`.
3. **Suppress feed/notification side-effects** for any achievement whose `earned_at < enrolled_at`. The user sees them on their profile (with historical dates) but no feed dump and no "23 new achievements!" notification.
4. From `enrolled_at` forward, normal real-time evaluation kicks in and side-effects fire.

This is the difference between "delightful" and "spammy" for the 73 users with 1000+ historical ticks.

### 6.5 Failure modes

| Failure                                | Effect                                                       | Recovery                                  |
| -------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| Evaluator throws                       | Logged with `user_id` + `evaluator.id`, others continue      | Backfill job re-runs nightly              |
| Race: same achievement evaluated twice | `ON CONFLICT DO NOTHING` on UNIQUE constraint                | None needed                               |
| Tick deleted (`deleteTick`)            | Source-of-truth counters change. Achievement stays.          | We do **not** revoke earned achievements. |
| Aurora bulk re-sync                    | Could re-trigger same evaluators on already-evaluated ticks. | Idempotent by design.                     |

---

## 7. Session feature integration

This is the core deliverable — achievements should make the existing session UI feel different on day one, not just add a new "/achievements" page.

### 7.1 Session detail page (`packages/web/app/session/[sessionId]/`)

Above the existing climb list, add an **Achievements strip**: horizontal row of any badges earned in this session, with the metric value ("V7 — your hardest yet", "12 sends, your top 5%"). Tap = expand to a small dialog with the criteria. Strip is empty-state friendly — if no achievements fired, show nothing rather than an empty placeholder.

Threading achievements through `SessionDetailContent` means the GraphQL `SessionDetail` type gains a `achievements: SessionAchievement[]` field, fetched in the same query the page already runs. No extra round-trip.

### 7.2 Session summary dialog (`session-summary-view.tsx`)

This is the modal that pops up at the end of a party session today. It already shows totals + grade pyramid. We add a **"What you earned today"** section between header stats and the grade chart. New achievements get a brief animation; already-earned-but-still-relevant tier progress gets a quieter "8/10 sends toward Volume Silver" progress bar.

### 7.3 Session feed card (`session-feed-card.tsx`)

The compact card on the activity feed already shows participants and grade chart. Add up to 3 achievement chips below the grade chart. If a session contained a `pr_session` or `grade.first.*` award, it gets a subtle visual treatment — not a glowing border, just a small icon next to the title. This is the moment the social loop closes: a friend sees "Marco hit his first V8" without us writing a separate "achievement post" feed item.

### 7.4 "You" page (`packages/web/app/you/`)

Add a new tab `/you/achievements` next to logbook + sessions. Default view: grouped by family, tier-progress bars for in-progress ones, recently-earned at top. Hidden achievements show only after they fire.

### 7.5 OG image / share card

`/api/og/session/...` already renders a social card. Inject the top achievement (highest tier, most recent) into the bottom strip of the OG image when present. Most shareable moment becomes the headline.

### 7.6 Profile page (`/profile/[user_id]`)

Show top 6 highest-tier achievements as a row near the top, with a "See all" link to the user's `/achievements`. Respects the existing public/private visibility model.

### 7.7 Per-angle stats surface (`/you/angles`)

A direct response to user feedback — _"would be great to see my stats across angles."_ Lives next to `/you/achievements` as a sibling tab, also accessible from a "Stats by angle" link on the user's profile.

Layout (sketch — final design lives in Figma):

- Top: a small bar showing the user's send count per angle (5° increments), sorted by angle. Tap an angle bar = filter the rest of the page to that angle.
- Per-angle card grid (one card per angle the user has sent at): max grade (PR), average grade, send count, flash count, hardest project. Tap = a drill-down with the actual climbs.
- A second view toggle: **"Compared to you"** — for each angle, shows your distribution overlaid on the gym/global distribution at that angle (e.g. "you tend to send harder at 50° than your overall PR suggests"). This is the climber-improvement frame the feedback specifically called out.
- Surfaces achievements from §4.5.1 inline — a "V7 PR at 50°" badge sits on the 50° card the moment it fires.

This page is the _real_ deliverable from the angle feedback. The achievements are the gamified hook into it.

Implementation notes:

- All data comes from the existing `boardsesh_ticks` indexes — `boardsesh_ticks_user_climbed_at_idx` covers the per-angle per-user query cheaply. No new tables needed.
- Comparison data ("you vs gym at 50°") needs a small materialized view (`per_angle_grade_distribution`, refreshed nightly) or inline aggregation. Start with global comparison (every Boardsesh user); add gym-specific if/when the gym membership table fills out (currently 0 rows in `gym_members`).
- Server-rendered. The data is small enough (~22 angles × ~22 grades = 484 cells max).

---

## 8. Phased rollout

Each phase ships behind a single boolean flag in `community_settings` so we can dark-launch and pull the chain.

### Phase 1: foundation (1–2 weeks)

- Migration: `achievement_definitions`, `user_achievements`, indexes.
- TS catalog file + sync-on-boot.
- Evaluator framework (interface, trigger registry, queue, idempotent writes).
- 5 evaluators: `lifetime.total_sends`, `lifetime.sessions_logged`, `grade.first.{V}`, `session.first_send`, `session.send_count`.
- Backfill script (silent, no notifications).
- `/you/achievements` page (read-only, no UI elsewhere).

Success criterion: the 73 users with 1000+ ticks each see a coherent achievement collection, no feed pollution.

### Phase 2: session integration (1 week)

- Session detail strip + summary dialog section + feed card chips.
- Add 4 more session evaluators: `pr_session`, `redpoint`, `long_haul`, `angle_explorer`.
- **`session.v_points`** evaluator + V-points number on session summary, with half-grade scoring rule (§4.1.1).
- OG image integration.

### Phase 2.5: crew V-points (1 week, only if Phase 2 lands cleanly)

- **`session.crew_v_points`** evaluator for explicit multi-user sessions.
- Live crew V-point counter on the active party-session header — this is the "10 friends gang up for 1000" social loop.
- Push notification when a crew session crosses each tier in real time.

Success criterion: every active user (213 in last 30d) sees ≥1 achievement on their next session detail page.

### Phase 3: rhythm + social (1 week)

- Periodic trigger + weekly cron.
- Rhythm evaluators (`weekly_x3`, `weekly_x4`, `comeback`).
- Social evaluators (`first_follow`, `crew_session`).
- Notifications + feed_items writes (post-enrollment only).

### Phase 4: exploration + mirror + hidden + polish (1 week)

- Remaining evaluators (`explore.*`, `mirror.*`, `session.mirror_balanced`, `session.full_mirror`, `hidden.*`, `project.*`).
- Year-in-review generator.
- Profile achievements row.

The mirror evaluators are cheap to add (small cohort, narrow query surface) and bundle naturally with exploration. They'll drop ~20 instant awards on the existing power-user cohort during silent backfill, then run live for the rest.

### Phase 4.5: beta contributor track (1 week)

- New `beta_link_created` trigger emitted from the beta-link insert path.
- All §4.7 evaluators: `first_share`, `contributor.{n}`, `first_on_climb`, `fills_demand`, `from_the_source`, `hard_send`, `benchmark`, `session_share`.
- A "Climbs that need beta" surface on the climb-detail and `/you` pages — pulls from the §3.8 supply-gap query — to make the achievement progress legible. Without this surface the achievements fire but feel arbitrary.
- Recalibration check at 30 days: re-run the SQL in Appendix B; bump tier thresholds if any tier is granted to >40% of contributors.

### Phase 5: instrumentation + iteration (ongoing)

- PostHog event for every achievement granted (`{achievement_id, tier, source: 'realtime'|'backfill'}`).
- Dashboard: grant rate per achievement, time-to-first-grant per cohort, opt-out rate.
- Quarterly review: any achievement granted to <2% or >95% of active users gets re-tiered.

---

## 9. Open questions

1. **In-app vs Aurora flash distinction.** Do we add a `source` column to `boardsesh_ticks` (`'aurora'|'app'|'manual'`)? Or infer from `aurora_synced_at IS NOT NULL`? The latter is free but drift-prone. Worth a small data audit before committing.
2. **Should achievements ever be revoked?** If a user deletes a tick that earned them an award, do we keep, demote, or delete the row? Soft proposal: keep it — climbers don't want to "un-earn" things, and the deletion is usually a typo fix.
3. **Privacy.** Do public profiles show all achievements, only top N, or none unless the user opts in? Default proposal: top 6 visible, full list private. Mirror existing follower-graph privacy.
4. **Localization.** Display names and descriptions are i18n keys per CLAUDE.md. Variant strings (V6, V8 …) need format helpers — the existing `useGradeFormat` hook covers this.
5. **HealthKit hand-off.** Sessions already optionally write to HealthKit (`healthKitWorkoutId`). Should achievements get a HealthKit metadata field too, or stay app-internal? Suggest app-internal until there's user demand.
6. **Cross-board grade scaling.** A "First V8 on Tension" should probably count differently from a "First V8 on Kilter" because the grading scales differ. Variant = `V8:kilter` keeps them separate by construction; if we want a unified "Hardest V-grade" achievement we'd need a board-grade calibration table. Out of scope for v1.
7. **Anti-cheating.** Anyone can write a tick. Do we need rate limits, "achievement granted but unverified" badges, or anything? For v1, no — the social cost of fake sends in a friend graph is enough deterrent. Revisit if leaderboards ever exist.

---

## 10. What we're explicitly not doing

- **Points / XP / levels.** No "Climber Level 27." Achievements are categorical, not numeric.
- **Global leaderboards.** Closest thing is the existing follower feed; we won't add ranking screens.
- **Daily-streak push notifications.** See §2 principle 2 — bad climbing advice.
- **Per-user custom goals as achievements.** Goals already exist on `board_sessions.goal`. Merging them with the achievements system muddles "I described what I wanted" with "the system noticed something happened."
- **Aurora-synced achievement state.** Achievements are a Boardsesh primitive; we don't push them back to Aurora.

---

## Appendix A — sample evaluator (illustrative)

```ts
// packages/backend/src/achievements/evaluators/grade-first.ts
import { eq, and, lt, sql } from 'drizzle-orm';
import { boardseshTicks, boardDifficultyGrades } from '@boardsesh/db/schema';
import type { Evaluator } from './types';

export const gradeFirstEvaluator: Evaluator = {
  id: 'grade.first',
  triggers: ['tick_saved'],

  async evaluate({ user, trigger, db }) {
    if (trigger.kind !== 'tick_saved') return [];
    const tick = trigger.tick;
    if (tick.status !== 'send' && tick.status !== 'flash') return [];
    if (tick.difficulty == null) return [];

    // Was anything at this difficulty (or harder) sent before this tick?
    const earlier = await db
      .select({ id: boardseshTicks.id })
      .from(boardseshTicks)
      .where(
        and(
          eq(boardseshTicks.userId, user.id),
          eq(boardseshTicks.boardType, tick.boardType),
          sql`${boardseshTicks.difficulty} >= ${tick.difficulty}`,
          sql`${boardseshTicks.status} IN ('send','flash')`,
          lt(boardseshTicks.climbedAt, tick.climbedAt),
        ),
      )
      .limit(1);

    if (earlier.length > 0) return [];

    const [grade] = await db
      .select({ name: boardDifficultyGrades.boulderName })
      .from(boardDifficultyGrades)
      .where(
        and(eq(boardDifficultyGrades.boardType, tick.boardType), eq(boardDifficultyGrades.difficulty, tick.difficulty)),
      );

    return [
      {
        achievementId: 'grade.first',
        // toVDisplay('6c+/V5')  -> 'V5+', toVDisplay('7a/V6') -> 'V6'
        // (defined in shared-schema/grades — half-grades emit V3+/V4+/V5+/V8+)
        variant: `${toVDisplay(grade?.name) ?? tick.difficulty}:${tick.boardType}`,
        tier: 1,
        earnedAt: tick.climbedAt,
        sourceTickId: tick.id,
        sourceSessionId: tick.sessionId ?? undefined,
        metricValue: tick.difficulty,
      },
    ];
  },
};
```

### Appendix A.1 — V-points session evaluator (illustrative)

```ts
// packages/backend/src/achievements/evaluators/session-v-points.ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { boardseshTicks, boardDifficultyGrades } from '@boardsesh/db/schema';
import type { Evaluator } from './types';

const TIERS = [25, 50, 100, 200];

export const sessionVPointsEvaluator: Evaluator = {
  id: 'session.v_points',
  triggers: ['session_closed'],

  async evaluate({ user, trigger, db }) {
    if (trigger.kind !== 'session_closed') return [];
    const session = trigger.session;

    // Per-(climb, orientation) dedup: each unique (user, session, climb,
    // is_mirror) tuple contributes its v_points exactly once. Mirrored and
    // non-mirrored sends of the same hold pattern count separately — direct
    // user feedback: "the same climb feels very different on the other side."
    // Half-grades from board_difficulty_grades are pre-computed into a
    // materialized view `board_grade_points` (board_type, difficulty,
    // v_display, v_points) at startup.
    const [{ totalVPoints }] = await db.execute(sql`
      WITH per_climb AS (
        SELECT DISTINCT t.climb_uuid, COALESCE(t.is_mirror, false) AS mirrored, p.v_points
        FROM boardsesh_ticks t
        JOIN board_grade_points p
          ON p.board_type = t.board_type AND p.difficulty = t.difficulty
        WHERE t.user_id = ${user.id}
          AND t.session_id = ${session.id}
          AND t.status IN ('send','flash')
      )
      SELECT COALESCE(SUM(v_points), 0) AS "totalVPoints" FROM per_climb;
    `);

    const earned: number[] = TIERS.filter((threshold) => totalVPoints >= threshold);
    return earned.map((threshold, index) => ({
      achievementId: 'session.v_points',
      tier: index + 1,
      variant: String(threshold),
      earnedAt: new Date(session.lastTickAt),
      metricValue: Math.round(totalVPoints * 10), // store as ×10 to keep .5s
      sourceSessionId: session.id,
    }));
  },
};
```

---

## Appendix B — analysis queries used

These can be re-run against any prod replica to refresh tier calibrations:

```sql
-- Tick volume per user (for tier calibration)
SELECT user_id, COUNT(*) FROM boardsesh_ticks GROUP BY 1;

-- Per-grade "hardest send" distribution per board
WITH user_max AS (
  SELECT user_id, board_type, MAX(difficulty) AS d
  FROM boardsesh_ticks WHERE status IN ('send','flash')
  GROUP BY 1,2
)
SELECT board_type, d, COUNT(*) FROM user_max GROUP BY 1,2 ORDER BY 1,2;

-- Sessions per ISO week per user (rhythm tier calibration)
SELECT created_by_user_id, DATE_TRUNC('week', COALESCE(started_at, created_at)::timestamp) AS wk, COUNT(*)
FROM board_sessions GROUP BY 1,2;

-- Day-streak distribution (validation that day-streaks are a bad signal)
WITH days AS (SELECT user_id, DATE(climbed_at) d FROM boardsesh_ticks GROUP BY 1,2),
     g AS (SELECT user_id, d, d - (DENSE_RANK() OVER (PARTITION BY user_id ORDER BY d))::int AS grp FROM days),
     runs AS (SELECT user_id, COUNT(*) r FROM g GROUP BY user_id, grp)
SELECT MAX(r), AVG(r) FROM runs GROUP BY user_id;

-- "Sent after attempting earlier" — redpoint achievement reachability
WITH first_attempt AS (
  SELECT user_id, climb_uuid, MIN(climbed_at) AS first_at
  FROM boardsesh_ticks WHERE status='attempt' GROUP BY 1,2
)
SELECT COUNT(DISTINCT t.session_id)
FROM boardsesh_ticks t
JOIN first_attempt fa USING (user_id, climb_uuid)
WHERE t.status IN ('send','flash') AND t.climbed_at > fa.first_at AND t.session_id IS NOT NULL;

-- V-points per session (with half-grade increments + per-climb dedup)
WITH dg AS (
  SELECT board_type, difficulty, boulder_name,
    CAST(SUBSTRING(boulder_name FROM 'V([0-9]+)') AS INT) AS v_int,
    SPLIT_PART(boulder_name, '/', 1) ~ '\+$' AS has_plus,
    LAG(CAST(SUBSTRING(boulder_name FROM 'V([0-9]+)') AS INT))
      OVER (PARTITION BY board_type ORDER BY difficulty) AS prev_v_int
  FROM board_difficulty_grades
), dg_pts AS (
  SELECT board_type, difficulty,
    CASE WHEN v_int = 0 THEN 0.0
         WHEN has_plus AND prev_v_int = v_int THEN v_int + 0.5
         ELSE v_int::numeric END AS v_points
  FROM dg
), tick_v AS (
  SELECT DISTINCT t.user_id, t.session_id, t.climb_uuid, p.v_points
  FROM boardsesh_ticks t
  JOIN dg_pts p ON p.board_type = t.board_type AND p.difficulty = t.difficulty
  WHERE t.status IN ('send','flash') AND t.session_id IS NOT NULL
)
SELECT session_id, SUM(v_points) AS v_points
FROM tick_v GROUP BY 1 ORDER BY v_points DESC LIMIT 50;

-- Beta supply gap: most-sent climbs with no beta video yet
WITH no_beta AS (
  SELECT DISTINCT board_type, climb_uuid FROM boardsesh_ticks WHERE status IN ('send','flash')
  EXCEPT
  SELECT DISTINCT board_type, climb_uuid FROM board_beta_links
)
SELECT t.board_type, t.climb_uuid, COUNT(*) AS sends
FROM boardsesh_ticks t JOIN no_beta n USING (board_type, climb_uuid)
WHERE t.status IN ('send','flash')
GROUP BY 1,2 HAVING COUNT(*) >= 5 ORDER BY sends DESC LIMIT 100;

-- Beta contributor recalibration (run 30/90 days post-launch)
SELECT created_by_user_id, COUNT(*) AS posts,
  COUNT(DISTINCT climb_uuid) AS distinct_climbs
FROM board_beta_links
WHERE created_by_user_id IS NOT NULL
GROUP BY 1 ORDER BY posts DESC;

-- Mirror cohort sizing + tier reachability
SELECT board_type,
  COUNT(*) FILTER (WHERE is_mirror=true AND status IN ('send','flash')) AS mirror_sends,
  COUNT(DISTINCT user_id) FILTER (WHERE is_mirror=true) AS users_who_mirror
FROM boardsesh_ticks GROUP BY 1 ORDER BY 2 DESC;

-- Per-angle grade distribution (powers the §7.7 angle stats surface)
SELECT user_id, angle, board_type,
  COUNT(*) FILTER (WHERE status IN ('send','flash')) AS sends,
  MAX(difficulty) FILTER (WHERE status IN ('send','flash')) AS max_d,
  AVG(difficulty) FILTER (WHERE status IN ('send','flash')) AS avg_d
FROM boardsesh_ticks GROUP BY 1,2,3;

-- Angle versatility (calibrates angle.versatile_v6 tiers)
WITH user_angle_v6 AS (
  SELECT DISTINCT user_id, angle FROM boardsesh_ticks
  WHERE status IN ('send','flash') AND difficulty >= 22
)
SELECT user_id, COUNT(*) AS angles_at_v6_plus
FROM user_angle_v6 GROUP BY 1 ORDER BY 2 DESC;

-- Per-user 'sent both ways' counts (calibrates mirror.both_ways tiers)
WITH per_climb AS (
  SELECT user_id, climb_uuid, board_type,
    BOOL_OR(is_mirror=true AND status IN ('send','flash')) AS m,
    BOOL_OR(COALESCE(is_mirror,false)=false AND status IN ('send','flash')) AS n
  FROM boardsesh_ticks GROUP BY 1,2,3
)
SELECT user_id, COUNT(*) FILTER (WHERE m AND n) AS both_ways
FROM per_climb GROUP BY 1 ORDER BY 2 DESC;
```
