# DTB — Dropbox credential disclosure (source notes for outreach)

These are working notes for a Fable agent to shape into a partnership email with a
short, low-key security heads-up at the end. They are not the email. Keep the tone
of the heads-up collaborative, not alarmist: we found this while looking at how to
integrate, we have not tested anything, and the fix is small because DTB already
owns the backend to do it on.

Do not put any credential values, keys, tokens or the Dropbox app key in the email
or anywhere in the repo. Everything here is about the *shape* of the issue, not its
secrets.

## Who we are (for the partnership framing)

Boardsesh (boardsesh.com) adds queue management, collaborative control and a shared
climb catalogue on top of climbing-board software. We already support Kilter,
Tension, MoonBoard and others. We would like to support DTB walls, and we would
rather do it *with* DTB than around them.

## What we found, and how

- We looked only at the public Android app (`com.companyname.desktopmobileclient`),
  downloaded from a public APK mirror. We read its strings and its decompiled
  structure. We did **not** run the app against DTB's servers, and we did **not**
  use or test any credential. This was static analysis for interoperability.
- The 2.0.0 app fetches each wall's files (`wall.png`, `holdlist.csv`,
  `dicholdlist.txt`, `MirrorDic.txt`, `Settings`, and `walllist.csv`) directly from
  Dropbox (`content.dropboxapi.com/2/files/download`).
- To do that, the app carries a Dropbox credential and a token-refresh routine
  (`getAccessToken`, a standard OAuth `refresh_token` grant against
  `api.dropboxapi.com/oauth2/token`, with the app key/secret sent as HTTP Basic).

## Why it is worth a look (state plainly, do not overstate)

1. **Anything in a shipped app is extractable.** An APK is a zip. Whoever unpacks
   it can read these strings. So the Dropbox credential behind the wall files
   should be treated as public.
2. **A refresh token does not expire on its own.** Unlike a short-lived access
   token, it keeps minting new access tokens until DTB revokes it, so the exposure
   is durable rather than time-boxed.
3. **We do not know the scope.** We deliberately did not test the token, so we
   cannot say whether it is read-only or read-write, or whether it is limited to
   the wall folder or spans the whole Dropbox account. DTB can see this safely and
   instantly in their own Dropbox App Console — no testing needed. The severity
   depends entirely on that scope: a read-only, app-folder-scoped token over files
   that already ship to every user is low severity; a broader or writable token is
   not.

## The rotation trap (the reason "just rotate it" is not enough)

The credential is compiled into the app binary, so it can only be changed by
shipping a new app version. If DTB revokes the current token without more, every
already-installed app that still holds it loses the ability to fetch new or updated
wall files. Cached walls keep working; new or edited walls stop arriving until each
user updates. So rotation alone degrades the fleet on a long tail.

## The fix (small, because they already have the backend)

DTB already runs an ASP.NET backend: the SignalR "updater" hub and the newer Azure
Functions API that already handles accounts, problems, ticks, likes and comments
through authenticated endpoints. Wall files are the one asset class still routed
straight from the client to Dropbox.

Recommended sequence:

1. Add one endpoint on the existing backend, e.g. `GET /walls/{wallId}/{file}`,
   that holds the Dropbox credential **server-side** and streams the file back (or
   returns a short-lived Dropbox temporary link).
2. Ship an app update that fetches wall files from that endpoint instead of from
   Dropbox directly.
3. Now the token lives only on the server. Rotate it freely, whenever, without
   touching any installed app. Optionally cache/CDN the files so Dropbox becomes
   just the editing surface.

Framing note: their sensitive data (accounts, ticks) already goes through the
backend the right way. It is only the *least* sensitive assets — static wall files
— that got the direct-to-storage treatment, so this is a small consistency fix, not
a re-architecture.

## Tie-in to the partnership ask

The wall files are exactly the geometry Boardsesh needs to render and light DTB
walls. So the same fix that closes the exposure — serving wall files from an
authenticated endpoint — is also the clean integration surface for us. Instead of
anyone extracting a credential or scraping, DTB could give us (or the ecosystem) a
documented way to read wall geometry, and we build against that.

Concretely, ask DTB for either:

- an export of the wall files for the walls that opt in, or
- a documented read endpoint for wall geometry,

plus their view on the Bluetooth `preview_problem` message carrying hold roles (see
`docs/dtb-integration-spec.md` §2c and §7), so a Boardsesh-created climb can show
start/finish on the wall, not just in our app.

## Hard rules for the email

- No credential values, keys, tokens, or the Dropbox app key. Ever.
- Do not claim we tested the token or know its scope. We did not.
- Do not claim data was accessed or exfiltrated. It was not.
- Keep the security part short and last; lead with the partnership.
- Offer to share fuller technical detail privately if they want it.
