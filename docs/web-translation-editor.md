# Edit translations in the Next.js dev server

1. Open the running Next.js app at its printed dev URL or through localhost.
2. Select **Edit translations** in the bottom-right corner.
3. Hover over copy and select **Edit**, or click the copy while inspection is enabled.
4. Change the text and select **Save and reload**.
5. Check the resulting page at narrow and wide widths. Press Escape to stop inspecting.

The editor uses the page's current language. Use the website language selector to
edit another locale. **Search strings** finds catalog keys and wording, including
input placeholders, accessibility labels, and strings that are not currently
visible. When several keys could produce the same text, choose the intended
namespace and key explicitly. Inspection infers candidates from rendered copy;
verify the key in the dialog. Interpolation-only strings and nested `$t(...)`
references can be found through search.

The editor adds floating controls without adding spans, edit icons, or markers
inside existing page content. React still owns the original markup. Edits preserve
interpolation variables (including formatters), nested translation references,
rich-text tag order and attributes, and explicit line breaks. Variables may move
within a formatting region, but cannot move across a tag or line break. Empty
translations and new keys are rejected. Longer copy can still wrap or overflow;
the character counts help flag changes that need a visual check.

Saves update existing string leaves in
`packages/shared/i18n/locales/<locale>/<namespace>.json`, including string array
items. These catalogs are shared: mobile wording changes too when it uses an
edited key. The editor UI, API, and development disk loader exist only in the
Next.js app; native and Expo web do not gain an editor. A separate `devTools`
namespace keeps editor copy out of mobile bundles.

The page reloads after saving, resetting both server-rendered text and the browser
i18n singleton. The development server reads catalogs directly from disk so saves
do not wait for JSON module invalidation. Production retains the bundled loader.
Saves are serialized within the development process and written through a temporary
file plus atomic rename. A stale edit gets a conflict instead of overwriting a newer
version of that string. Avoid editing the same catalogs in multiple dev-server
processes or external editors at the same time; the queue is process-local.

The endpoint returns 404 outside `NODE_ENV=development`. File editing is restricted
to loopback URLs or exact hostnames in the launcher's `DEV_ALLOWED_ORIGINS`, with
a matching Host header. Wildcards are refused. Writes require an exact same-origin
Origin and JSON content type. The launcher's Tailscale hostname works; arbitrary
LAN or remote hostnames do not. Requests are size-limited and paths are
restricted to known locales, namespaces, and existing non-prototype keys. Review
catalog diffs and run the usual i18n checks before committing wording changes.
