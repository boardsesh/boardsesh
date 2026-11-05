# Paid social ads as code (Meta / Instagram, Reddit)

Our Instagram and Reddit campaigns live in the repo. A PR changes a campaign; a
merge to `main` applies it. It mirrors the Apple Ads setup (#7265) in shape:
declarative JSON, a CLI with `audit | plan | apply`, an offline plan on every PR,
and a Production-environment job on `main`.

| Piece | Where |
| ----- | ----- |
| Configs | `app-stores/meta/ads.json`, `app-stores/reddit/ads.json` |
| Creative files (Meta) | `app-stores/paid-social/creatives/` |
| CLI | `scripts/paid-social-ads.ts` (`vp run ads:meta`, `vp run ads:reddit`) |
| Reconcile + guardrails | `scripts/lib/paid-social.ts` |
| URL builder | `scripts/lib/paid-social-urls.ts` |
| API clients | `scripts/lib/meta-ads-client.ts` (Graph API v26.0), `scripts/lib/reddit-ads-client.ts` (Ads API v3) |
| Workflows | `.github/workflows/meta-ads.yml`, `.github/workflows/reddit-ads.yml` |
| Tests | `scripts/__tests__/paid-social*.test.ts` |

## Changing a campaign (the agent workflow)

1. Edit `app-stores/<platform>/ads.json`. Change budgets, copy, targeting or
   status there and nowhere else.
2. Run `vp run ads:<platform> -- --action plan --offline` locally. It prints
   every campaign, ad group and ad with its built destination URL and the
   planned active daily total.
3. Open a PR. The `Meta Ads` / `Reddit Ads` workflow runs the tests and uploads
   the same offline plan as the `<platform>-ads-preview` artifact. Read it.
4. Merge. The workflow on `main` checks out the newest `main`, plans against
   the live account (`<platform>-ads-plan.json`), applies, and reads back
   (`<platform>-ads-result.json`). A read-back difference fails the run. It
   applies only when the push changed the config or a creative; a push that
   only changes the scripts or the workflow plans and stops.

The config is the truth. A pause made by hand in Ads Manager lasts until the
next config change applies, which switches the entity back to what the config
says. To stop spend for good, pause it in the config.

To see the live account without changing it, dispatch the workflow with
`action: audit` (or `plan`). Locally: `vp run ads:meta -- --action audit` with
the credentials in your environment.

## Config shape

```json
{
  "version": 1,
  "platform": "reddit",
  "adAccountId": "a2_xxxxxxxx",
  "currency": "AUD",
  "namespace": "Boardsesh Managed",
  "maxDailyBudgetTotal": "20.00",
  "allowBudgetJump": false,
  "adoptCampaignIds": [{ "id": "1234567890", "code": "nov26-launch" }],
  "reddit": { "pixelId": "a2_xxxxxxxx" },
  "campaigns": [
    {
      "code": "nov26-launch",
      "status": "PAUSED",
      "objective": "CLICKS",
      "startDate": "2026-11-01",
      "endDate": "2026-11-30",
      "adGroups": [
        {
          "name": "homewalls",
          "status": "ACTIVE",
          "dailyBudget": "10.00",
          "targeting": {
            "countries": ["US", "AU"],
            "placements": ["FEED"],
            "interests": [],
            "communities": ["climbing", "bouldering"]
          },
          "ads": [{ "name": "homewalls-ad-1", "status": "ACTIVE", "creative": { "postId": "t3_abc123" } }]
        }
      ]
    }
  ]
}
```

- **Campaign name** on the platform is `<namespace> <code>`. `code` is the
  `utm_campaign` value: 1 to 18 characters of `[a-z0-9-]`.
- **Ad name** is the `utm_content` value: 1 to 40 characters of `[a-z0-9-]`,
  unique within the campaign.
- **Status** is `ACTIVE` or `PAUSED`. A campaign may also be `ADOPT_PENDING`
  (see below), which writes nothing.
- **Budget** is a daily decimal string in the account currency, set either on
  the campaign (campaign budget optimisation) or on every ad group, never
  both. There is no lifetime budget field; one is refused.
- **Dates** are UTC days. `startDate` is used when an ad group is created (or
  now, if that is later). `endDate` runs to 23:59 UTC. Clearing a live end
  date is refused; do it by hand.
- **Targeting**: `countries` (ISO codes), `placements` and `interests` on both
  platforms. Reddit adds `communities` (values as the audit prints them;
  Reddit has no age targeting). Meta adds `ageMin` / `ageMax` (18 to 65),
  `advantageAudience` (Advantage+ audience, which lets Meta reach past the
  interests; off unless set) and takes interests as `{ "id", "name" }` from the
  Targeting Search API. An interest with `"id": null` is a name not looked up
  yet: its ad group is reported as pending and nothing in it is created or
  edited (a pause still goes through). Meta ad
  sets are always Instagram-only: `placements` is the Instagram position list
  (`stream`, `story`, `reels`, `explore`, `explore_home`, `profile_feed`,
  `ig_search`). Reddit placements are `FEED` and `COMMENTS_PAGE`.
- Objectives are traffic only: `OUTCOME_TRAFFIC` (Meta), `CLICKS` (Reddit).
  Reddit announced new objective names from 2026-09-21; the v3 schema still
  lists `CLICKS`. A live objective cannot be changed.

### Destination URLs are built, never written

`scripts/lib/paid-social-urls.ts` is the only place a destination exists:

```
https://www.boardsesh.com/?utm_source=<reddit|instagram>&utm_medium=paid-social&utm_campaign=<code>&utm_content=<ad>
```

`utm_content` is always the literal ad name, on both platforms.

- **Reddit** ads get the full URL as `click_url`.
- **Meta** ads link to `https://www.boardsesh.com/` and carry the tags in the
  creative's `url_tags`, written out in full. We do not use Meta's
  `{{ad.name}}` macro: Instagram-app boosts never expand it (the live boost
  would have reported a literal `{{ad.name}}`), and one literal rule works for
  boosts and Ads Manager ads alike. The helper refuses the macro.

The live ads use exactly these URLs:

```
https://www.boardsesh.com/?utm_source=reddit&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1
https://www.boardsesh.com/?utm_source=instagram&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=ig-boost-1
```

The code length rule comes from the App Store `ct` token
([growth-metrics.md, "Paid social URLs"](growth-metrics.md#paid-social-urls-reddit-instagram)).

### Creatives

- **Meta, from a file**: `{ "image", "headline", "body", "callToAction" }`.
  `image` must be a `.jpg` or `.png` under `app-stores/paid-social/creatives/`.
  The creative's platform name is `<namespace> <ad> <hash>`, where the hash
  covers the image bytes, the copy, the link, the url_tags and the page and
  Instagram accounts. When the ad already points at a creative of that name,
  nothing is uploaded. Any change makes a new creative and repoints the ad
  (Meta re-reviews it). Needs `meta.pageId` and `meta.instagramUserId`.
- **Meta, existing**: `{ "existingCreativeId": "..." }`, for adopted ads. The
  plan warns if that creative's link differs from the built URL; it cannot fix
  it, so replace the creative with a file creative to fix the tags.
- **Reddit**: `{ "postId": "t3_..." }`. v1 does not create Reddit posts: make
  the post (title, body, media) in Ads Manager and reference it. We manage the
  ad's status and `click_url`.
- `null` ids mean "not known yet": the ad is reported as pending and not
  created. An adopted live ad with a `null` id keeps its current creative.

**No AI-generated images.** Creative files are real photos or real screen
recordings and screenshots of the app only (project rule in `CLAUDE.md`).

## Guardrails

Checked on the config (`validateConfig`, in every PR's tests and offline plan)
and again on the live plan before the first write (`planGuardrails`). An apply
with any violation makes no write at all.

1. **Spend cap.** The sum of active daily budgets (campaign `ACTIVE` and ad
   group `ACTIVE`) must be at most `maxDailyBudgetTotal`. Every single budget
   must be at most the cap too, even when paused. The cap itself must be at or
   under `PAID_SOCIAL_MAX_DAILY`, a variable on the GitHub `Production`
   environment that no PR can change; an apply refuses to run without it.
2. **No lifetime or unbounded budgets.** The config has no lifetime field, and
   every ad group needs a daily budget at one level. A live lifetime budget on
   a managed campaign or ad group blocks the apply.
3. **No more than double in one apply.** A budget raised above 2x its live
   value is refused, and so is a planned active total above 2x the live active
   total. Live spend counts only ad groups that are `ACTIVE`, have an `ACTIVE`
   ad and have not ended, so switching on idle ads or extending an ended ad
   group counts as new spend. Starting spend from zero counts. To allow it, set
   `"allowBudgetJump": true` in the same PR, and set it back to `false` in the
   next PR (the plan warns while it is on).
4. **Never delete.** No client has a delete call, and a status other than
   `ACTIVE` or `PAUSED` is refused before it is sent. A managed campaign, ad
   group or ad that leaves the config is paused.
5. **Only managed campaigns are written.** A campaign is managed when its name
   starts with `<namespace> ` or its id is in `adoptCampaignIds`. Everything
   else is read by audit and nothing else. The namespace is pinned to
   `Boardsesh Managed`: renaming it would orphan every managed campaign, still
   spending and outside the cap. A new campaign is refused while an unmanaged
   live campaign has its code in its name; adopt that one instead.
6. **Create paused, switch on last.** Every create is `PAUSED`. Activations run
   after all creates and edits, ads first, then ad groups, then the campaign.
   Pauses run first, campaign first. An ad whose configured creative cannot be
   built yet is never switched on.
7. **No silent audience widening.** A live ad group whose targeting uses fields
   the config cannot express (custom audiences, exclusions, regions, keywords,
   expanded targeting) blocks the apply, because rewriting the targeting would
   drop them. Remove them by hand or leave that campaign unmanaged.
8. **Newest `main`, one writer.** Every run reconciles the newest `main`, so a run
   queued behind a later merge applies the later config and a merged pause is
   never lost. Runs share a non-cancelling concurrency group.
9. **No secrets in output.** Tokens travel in headers or form bodies, never in a
   URL; error text is scrubbed of every credential; reports carry no headers.
   Pagination links are only followed on the API's own host.

## Adopting the live campaigns

Both configs ship with one campaign, `nov26-launch`, in `ADOPT_PENDING`, and
everything under it `PAUSED`, so merging them starts nothing.

### Instagram boosts cannot be adopted

The live Instagram ad is a boost made in the Instagram app (A$600 over 30
days), not an Ads Manager campaign. A boost has a lifetime budget and objects
only the Instagram app can edit, so it stays unmanaged:

- `audit` lists it with `managed: false` and `unmanagedReason: "lifetime budget
  (an Instagram boost or a lifetime campaign): cannot be adopted"`.
- Adopting its id is refused (the lifetime-budget guardrail).
- A managed campaign whose code appears in the boost's name is not blocked by
  it; the plan warns that the boost spends on its own, outside the cap.
- The managed equivalent is a new Ads Manager campaign in the config with a
  daily budget. `app-stores/meta/ads.json` already holds it as a mirror of the
  boost (US, JP, NL; 18+; Advantage+ audience on Indoor climbing and
  Bouldering; about A$20 a day; ad `ig-boost-1`). To run it: look up the two
  interest ids, set `meta.pageId`, `meta.instagramUserId` and a creative, set
  the status, and let the boost end (or stop it in the app) so the two do not
  overlap.

### Adopting an Ads Manager campaign

1. Fill `adAccountId` (and Meta's `currency` if it is not AUD) in the config.
2. Dispatch the workflow with `action: audit`. The `<platform>-ads-result`
   artifact lists every campaign with its ad groups, ads, budgets, targeting,
   destinations and creative or post ids.
3. In a PR: add `{ "id": "<live id>", "code": "nov26-launch" }` to
   `adoptCampaignIds`; copy the live ad group and ad names, budgets, targeting
   and the post id (Reddit) or creative id (Meta) into the config; set the
   campaign `status` to match the live one.
4. Read the offline plan, merge, then read the plan artifact. The first apply
   renames the campaign to `Boardsesh Managed nov26-launch`. Anything left
   different (a renamed ad group, a new budget) shows up as an operation:
   children matched by name, so a name you did not copy is paused and a new one
   is created.

## Credentials (Marco, one-time)

Store each value in 1Password first, then in the GitHub `Production`
environment. Until they exist, a push to `main` skips with a notice and a manual
dispatch fails.

First, the spend ceiling both platforms share (a daily amount per platform, in
the account currency). Raise it only on purpose; no PR can:

```bash
gh variable set PAID_SOCIAL_MAX_DAILY --env Production --repo boardsesh/boardsesh --body 20.00
```

### Reddit

The Ads API needs no allow-listing.

1. In Reddit Ads Manager, open Business > Developer Portal > Add Apps > Create an
   app (business admin only). Redirect URL: `https://www.boardsesh.com/oauth/reddit-ads`
   (it only has to match below). Note the app id and secret.
2. While signed in as the account that owns the ad account, open:
   `https://www.reddit.com/api/v1/authorize?client_id=<APP_ID>&response_type=code&state=boardsesh&redirect_uri=https://www.boardsesh.com/oauth/reddit-ads&duration=permanent&scope=adsread,adsedit`
   and Allow. Copy the `code` from the redirect URL (drop a trailing `#_`).
   Use it within 10 minutes.
3. Exchange it for a refresh token:
   ```bash
   curl -X POST https://www.reddit.com/api/v1/access_token \
     -A 'boardsesh-ads-as-code/1.0' -u '<APP_ID>:<APP_SECRET>' \
     -d 'grant_type=authorization_code&code=<CODE>&redirect_uri=https://www.boardsesh.com/oauth/reddit-ads'
   ```
   Keep `refresh_token` from the response.
4. Save the three values in 1Password (item "Reddit Ads API"), then:
   ```bash
   gh secret set REDDIT_ADS_CLIENT_ID --env Production --repo boardsesh/boardsesh
   gh secret set REDDIT_ADS_CLIENT_SECRET --env Production --repo boardsesh/boardsesh
   gh secret set REDDIT_ADS_REFRESH_TOKEN --env Production --repo boardsesh/boardsesh
   ```
   (each prompts for the value, so it never lands in shell history).
5. In a PR, set `adAccountId` in `app-stores/reddit/ads.json` (Ads Manager >
   account settings) and `reddit.pixelId` (Events Manager; required to create
   an ad group since 2026-07-13).

### Meta

1. At developers.facebook.com, create an app of type Business, owned by the
   Boardsesh business portfolio, and add the Marketing API product.
2. In Business settings > Users > System users, add a system user (Admin).
   Assign it the ad account with full control (manage campaigns), the Facebook
   Page and the Instagram account the ads run from.
3. On that system user, Generate token: pick the app, expiry **Never**, scopes
   `ads_management`, `ads_read`, `business_management`,
   `pages_read_engagement`, `pages_show_list`, `instagram_basic`.
4. Save the token in 1Password (item "Meta Ads system user"), then:
   ```bash
   gh secret set META_ADS_ACCESS_TOKEN --env Production --repo boardsesh/boardsesh
   ```
5. In a PR, set `adAccountId` (the digits, without `act_`), `currency`,
   `meta.pageId` and `meta.instagramUserId` in `app-stores/meta/ads.json`.
   The ad account id lives in the config, not a secret: it is not secret and
   the plan needs it.

## Limits of v1

- Reddit posts are not created; ads reference an existing post.
- Meta creatives are single-image link ads; no video or carousel.
- Clearing an end date, changing an objective and switching between campaign
  and ad-group budgets are refused and done by hand.
- Interests and communities are passed through as ids; look them up with each
  platform's targeting search or copy them from an audit.
