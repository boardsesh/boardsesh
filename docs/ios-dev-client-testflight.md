# Boardsesh Dev on iOS

Boardsesh Dev is a Debug Expo development client distributed through **TestFlight
Internal Only**. It installs alongside Boardsesh and connects to Metro for live JS
changes, Fast Refresh, the dev menu, and JavaScript debugging. Metro runs on the
developer's computer, not inside the installed app. Native dependencies still
require a new binary.

Expo documents [development-client delivery through TestFlight](https://github.com/expo/skills/blob/main/plugins/expo/skills/expo-dev-client/SKILL.md).
Apple's [Internal Only export](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)
prevents these builds being submitted to the App Store or external testers. The
first upload must still finish Apple processing and be checked on a physical
iPhone; a successful archive alone does not prove the launcher works.

## 1. Register the Dev identifiers in Apple Developer

Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list).
Use the existing Boardsesh team (`9L3HKPZBH3`). Register these explicit App IDs:

| App ID | Capabilities |
| --- | --- |
| `com.boardsesh.app.dev` | App Groups, Push Notifications, Sign in with Apple, HealthKit |
| `com.boardsesh.app.dev.widgets` | App Groups |
| `com.boardsesh.app.dev.share-extension` | App Groups |

Register **App Group** `group.com.boardsesh.app.dev` and assign it to all three
App IDs. Configure the main App ID's Sign in with Apple capability as **grouped
with the existing primary `com.boardsesh.app`**, rather than creating a separate
primary identity. See [Apple's grouping steps](https://developer.apple.com/help/account/capabilities/group-apps-for-sign-in-with-apple/).

The Dev app has its own custom scheme `com.boardsesh.app.dev://`; public Boardsesh
Universal Links keep opening the normal app. Dev data, authentication tokens,
widget state, and cross-process notifications use a separate namespace.

## 2. Create three distribution profiles

In Profiles, create **App Store Connect** distribution profiles for all three
App IDs. Select the same Apple Distribution certificate already used by the
production workflow. Download each `.mobileprovision` file.

The existing `IOS_P12_CERTIFICATE_BASE64` and `IOS_P12_PASSWORD` secrets can be
reused when those profiles select that certificate. A development or ad hoc
profile is not suitable for this workflow. No device UDIDs are required.

Upload each downloaded profile to the GitHub **Production** environment:

| Profile App ID | GitHub secret |
| --- | --- |
| `com.boardsesh.app.dev` | `IOS_DEV_APP_PROVISIONING_PROFILE_BASE64` |
| `com.boardsesh.app.dev.widgets` | `IOS_DEV_WIDGETS_PROVISIONING_PROFILE_BASE64` |
| `com.boardsesh.app.dev.share-extension` | `IOS_DEV_SHARE_EXTENSION_PROVISIONING_PROFILE_BASE64` |

For example, this reads the file without putting its contents in command arguments:

```sh
base64 < /path/to/BoardseshDev.mobileprovision | gh secret set IOS_DEV_APP_PROVISIONING_PROFILE_BASE64 --env Production
```

Repeat with the widget and share secrets. The signing script verifies bundle IDs,
team, expiry, App Group, distribution type, and production APNs before archiving.

## 3. Create the separate App Store Connect app and tester group

In [App Store Connect → Apps](https://appstoreconnect.apple.com/apps), select **+
→ New App**. Choose iOS, name **Boardsesh Dev**, primary language English, bundle
ID `com.boardsesh.app.dev`, and SKU `boardsesh-ios-dev`. Restrict app access to
the team members who will test it.

Under **TestFlight → Internal Testing**, create a **Metro Developers** group.
Enable automatic distribution and add the intended App Store Connect users.
There is no public beta link or external tester group for this build. Apple
allows [100 internal testers and 90 days per build](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).

Use the existing App Store Connect API key secrets. If that key is restricted to
selected apps, give it access to Boardsesh Dev. The workflow finds the app by
bundle ID, so no numeric App Store Connect app ID needs to be copied into code.

## 4. Configure Google sign-in, push credentials, and the backend

In the existing Google Cloud OAuth project, create an **iOS OAuth client** for
`com.boardsesh.app.dev`. Keep the current Web OAuth client. Set its new iOS
client ID in repository variable `EXPO_PUBLIC_GOOGLE_IOS_DEV_CLIENT_ID` and in
the developer's mobile `.env` with the same name. The Dev binary registers the
new reversed-client callback scheme automatically. Do not reuse the production
iOS client ID for the Dev app.

Set these backend environment variables before testing provider sign-in:

```dotenv
APPLE_DEV_BUNDLE_ID=com.boardsesh.app.dev
GOOGLE_IOS_DEV_CLIENT_ID=<new iOS OAuth client ID>
```

Apply the generated migration adding `activity_push_tokens.bundle_id`, then
deploy the backend and web callback changes **before distributing Dev**. Existing
clients and token rows keep the production default. Browser provider, Kilter,
and Strava callbacks carry a signed, allowlisted app variant back to the correct
installed app.

Both TestFlight apps use **production APNs**. The direct APNs key must authorize
both app topics; check its scope in Apple Developer. Existing `APNS_BUNDLE_ID`
continues to name the production app. Dev Live Activity registrations carry the
Dev bundle ID, so the backend sends updates and ends to the appropriate topic.

For ordinary notifications delivered through Expo's push service, register the
Dev bundle's APNs credentials under the existing Expo project too. Run
`BOARDSESH_IOS_APP_VARIANT=dev vp dlx eas-cli@16 credentials --platform ios`, choose the Dev TestFlight profile,
and configure its push key. Local/GitHub distribution signing does not by itself
configure Expo's push service.

## 5. Build, install, and connect

After the changes are on `main` and the setup above is complete, run **GitHub
Actions → iOS Dev Client (TestFlight) → Run workflow**, selecting `main`. A manual
run forces a rebuild by default. Once the first build is verified, set repository
variable `IOS_DEV_TESTFLIGHT_ENABLED=true` to enable automatic builds and renewal.

Automatic pushes build only when the Dev native fingerprint changes. A weekly
check renews clients at 60 days old, before the 90-day expiry. JavaScript-only
changes reuse the installed client. Only a successfully processed **Internal
Only** build becomes the reusable baseline, published as an `rn-ios-dev-*`
prerelease with `ios-dev-build.json`. Failed/invalid/expired/unprocessed builds
cannot establish a reusable baseline. This workflow does not publish production
OTA updates or App Store release tags.

Accept the internal TestFlight invitation and install **Boardsesh Dev**. TestFlight
installation does not require Developer Mode. Open its launcher and enter the
Metro HTTP URL, or start Metro with a Dev-specific launch scheme:

```sh
vp run dev:mobile -- --scheme com.boardsesh.app.dev
```

Use the same Wi-Fi network, or Tailscale on both devices. After JS loads,
**More → Metro Bundler** can save and switch server URLs. With no reachable
server, return to the launcher and select a working address. Never change
production's network permissions to make a Dev server reachable.

Check these flows on a physical iPhone with both apps installed:

1. Install Dev from TestFlight; both app icons appear.
2. Connect to Metro; an edited screen refreshes without reinstalling.
3. Sign in with Apple/Google; callbacks return to the initiating app.
4. Start a board session; BLE and Dev widgets control its queue.
5. Background/end the session; Dev Live Activity updates and disappears.

Repeat with the normal app and verify its credentials and widget state are
independent. Test browser fallback and Kilter/Strava connection callbacks too.
Metro JavaScript debugging is available, but attaching a native Xcode debugger
still requires a separate development-signed installation.

The optional EAS `development-testflight` profile expresses the same Debug/store
build identity. The automated GitHub workflow additionally sets Internal Only
export, validates signing, waits for Apple processing, and controls renewal; use
that workflow for the managed internal distribution path.
