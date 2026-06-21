# App Store Submission Guide

Step-by-step instructions for submitting Boardsesh to the iOS App Store.

## Prerequisites

- Apple Developer Program membership ($99/year) - https://developer.apple.com/programs/
- Xcode 15 or later installed
- An iOS Distribution certificate in your Apple Developer account
- An App Store provisioning profile for `com.boardsesh.app`
- Team ID: `9L3HKPZBH3`
- Bundle ID: `com.boardsesh.app`

Make sure your signing certificate and provisioning profile are installed in Xcode before starting. You can check this in Xcode > Settings > Accounts > your Apple ID > Manage Certificates.

---

## 1. App Icon and Splash Screen

The app icon and splash screen are defined in `packages/mobile/app.config.ts` (`icon: ./assets/icon.png` and the `expo-splash-screen` plugin pointing at `splash-icon.png`). There is no separate asset-generation step.

`expo prebuild` reads `app.config.ts` and generates the native iOS asset catalog and `Info.plist` (these aren't committed). The build flow in section 3 runs prebuild for you. If you've changed the source images, just regenerate the build — the new icon and splash flow through automatically.

---

## 2. Take Screenshots

Automated native capture (the real RN app, dark theme) via Maestro:

```bash
vp run mobile:screenshots -- --platform ios --backend prod --theme dark --devices common --locales all
```

This drives the common iPhone simulator set against prod (signed in as the test
user) and saves PNGs to `app-stores/apple/screenshots/<app-store-locale>/<device>/`
— e.g. `app-stores/apple/screenshots/en-US/iphone-16-pro-max/`. See
`packages/mobile/.maestro/README.md` for prerequisites (Maestro, the
`SCREENSHOT_USER_PASSWORD` env, etc.).

### Required screenshot sizes

| Device                          | Resolution | Required?                             |
| ------------------------------- | ---------- | ------------------------------------- |
| 6.9" iPhone (iPhone 16 Pro Max) | 1320x2868  | Yes — the only size the flow captures |
| 13" iPad (iPad Pro)             | 2064x2752  | Not required while tablet is disabled |

We capture a single device size, the 6.9" iPhone 16 Pro Max. App Store Connect
**auto-scales the largest screenshot down** to every smaller iPhone, so one 6.9"
set covers the whole device range — extra device sizes are invisible to users and
add no ranking value, only CI time. The axis that helps the listing is locale, so
that stays a full sweep. (See
<https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots/>.)

The app currently has `supportsTablet: false`, so iPad screenshots are not part
of the automated set. `--locales all` captures `en-US`, `es`, and `fr`; the
single Spanish app locale is uploaded to both App Store Connect Spanish locales:
`es-ES` and `es-MX`.

Dark is the canonical appearance; pass `--theme light` for a light set.

### Manual alternative

If you need a specific screen the flow doesn't cover:

1. Open Xcode > Window > Devices and Simulators
2. Create or select an iPhone 16 Pro Max simulator
3. Run the app in the simulator
4. Navigate to each key screen:
   - Board selection / home feed
   - Climb list with search results
   - Climb detail with hold overlay on board image
   - Record / start a session
   - Discover / playlists
   - Profile stats
   - Logbook / profile stats
5. Press Cmd+S in the simulator to save a screenshot

### Screenshot tips

- Use the demo account (test@boardsesh.com / test) so there is real data in the logbook.
- Show a variety of boards (Kilter and Tension at minimum).
- Make sure the queue has 3-5 climbs to show the feature clearly.
- For the Bluetooth screenshot, show the scanning/pairing UI (it does not need a connected board).

### Automated upload to App Store Connect

You don't have to upload screenshots by hand. The **Mobile Screenshots (Native)**
GitHub workflow captures the screenshots fresh and uploads them to App Store
Connect via `fastlane deliver` — screenshots **only**, no binary, no text
metadata, and no review submission. (The PNGs are no longer committed to the
repo; they're regenerated each run.)

**How to run it:** Actions → **Mobile Screenshots (Native)** → **Run workflow**,
and set **upload** to `true`. Leaving `upload` unset (the default, and what the
nightly cron uses) only captures and saves the artifact — it never touches App
Store Connect.

What it does:

1. Captures common iPhone screenshots on simulators, against **prod** (signed in
   as the test user) for every supported app locale — the canonical store
   recipe, with no local backend needed.
2. Runs `vp run check:screenshot-dimensions`, which fails the run if any PNG
   isn't an Apple-accepted size for its slot (so Apple can't reject the upload
   for a bad resolution).
3. Runs `fastlane ios screenshots` (`fastlane/Fastfile`), which uploads the PNGs
   with `skip_binary_upload`, `skip_metadata`, and `submit_for_review: false`.
   deliver routes each image to its display slot by pixel dimensions
   (1320×2868 → the 6.9" iPhone slot); the `00-`/`01-` filename prefixes set the
   display order inside each device slot.

**Authentication** uses the App Store Connect API key already configured for the
TestFlight workflows — no new secrets:

| Secret                             | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `APP_STORE_CONNECT_API_KEY_ID`     | API key id; names the decoded `.p8` (`AuthKey_<id>.p8`)      |
| `APP_STORE_CONNECT_API_KEY_BASE64` | base64 of the `.p8` key; decoded at runtime, never committed |
| `APP_STORE_CONNECT_ISSUER_ID`      | API issuer id                                                |

> **The App Store version must be in an editable state.** deliver writes
> screenshots to the version currently in **Prepare for Submission**. If the run
> fails with a "could not find app/version" error, open App Store Connect, create
> or open the next version so it's editable, then re-run the workflow. The lane
> sets `submit_for_review: false` and `skip_app_version_update: true`, so it only
> edits screenshots — it never bumps the version or submits for review.

**Re-running is safe.** With `overwrite_screenshots` + `sync_screenshots`, each
run replaces the App Store Connect screenshot set with exactly the captured PNGs,
so a re-run converges rather than piling up duplicates.

To run the lane locally instead (after capturing with `vp run mobile:screenshots`),
see `fastlane/README.md`.

---

## 3. Build & Archive

Production builds go through **EAS Build**, not a manual Xcode archive:

```bash
eas build --profile production -p ios
```

This is what the `.github/workflows/ios-testflight-rn.yml` pipeline runs. EAS runs `expo prebuild`, installs CocoaPods, and produces the signed archive; version and build numbers are managed remotely (`appVersionSource: "remote"` in `eas.json`).

### Local Xcode build (optional)

To build locally instead:

```bash
vp run mobile:ios
```

This runs `expo prebuild` (which generates the `packages/mobile/ios/` project and installs pods during prebuild) and then a cached Xcode build of that generated project. If you need an archive from Xcode, open the prebuild-generated `packages/mobile/ios/` workspace, set the target to **Any iOS Device (arm64)**, and run **Product > Archive**.

If a build fails:

- Check that your signing certificate is valid and not expired.
- Check that the provisioning profile matches the bundle ID `com.boardsesh.app`.
- Re-run `expo prebuild` to regenerate the native project and reinstall pods.

---

## 4. Upload to App Store Connect

1. In the Xcode Organizer (**Window > Organizer**), select the archive you just created.
2. Click **Distribute App**.
3. Select **App Store Connect** as the distribution method.
4. Select **Upload** (not Export).
5. Leave the default options (bitcode, symbols, etc.) and click **Next**.
6. Select the signing profile **Boardsesh App Store Distribution** (should be auto-detected).
7. Click **Upload**.
8. Wait for the upload to complete. You will see a success message.

The build will appear in App Store Connect within 5-30 minutes after upload. Apple runs automated processing (including a basic compliance check) before it becomes available.

---

## 5. Configure in App Store Connect

Go to https://appstoreconnect.apple.com and sign in with your Apple Developer account.

### If this is the first submission

1. **My Apps > + (New App)**
2. Fill in:
   - Platform: iOS
   - Name: Boardsesh
   - Primary Language: English (U.S.)
   - Bundle ID: com.boardsesh.app
   - SKU: com.boardsesh.app (or any unique string)

### For all submissions

1. Select the app, then go to the current version (e.g., 1.0).
2. The listing text (subtitle, description, keywords, what's new, support/marketing URLs, review notes) lives in `fastlane/metadata/en-US/` and is uploaded by the `ios metadata` fastlane lane — you normally don't fill these in by hand. For the operational steps and the canonical field reference, see `app-stores/apple/app-store-metadata.md`. If you do edit a field manually in App Store Connect, use the values from those fastlane files so the next lane run doesn't overwrite your changes.
3. Upload screenshots for each required device size — or run the automated
   upload (see "Automated upload to App Store Connect" under section 2).
4. Set the **App Category** to Health & Fitness (primary) and Sports (secondary).
5. Set **Age Rating** to 4+ (no objectionable content).
6. Set **Copyright** to `2024-2026 Boardsesh contributors`.
7. Set **Privacy Policy URL** to `https://boardsesh.com/privacy`.

---

## 6. Privacy Questionnaire

App Store Connect asks about data collection during submission. Answer based on the privacy labels in the metadata doc.

### Do you collect data? **Yes**

### Data types collected

**Contact Info - Email Address**

- Usage: App Functionality
- Linked to user's identity: Yes
- Used for tracking: No

**Contact Info - Name**

- Usage: App Functionality
- Linked to user's identity: Yes
- Used for tracking: No

**Location - Precise Location**

- Usage: App Functionality
- Linked to user's identity: Yes
- Used for tracking: No

**Health & Fitness - Fitness Activity**

- Usage: App Functionality
- Linked to user's identity: Yes
- Used for tracking: No

**Diagnostics - Usage Data**

- Usage: Analytics
- Linked to user's identity: No
- Used for tracking: No

### For all data types

- **Do you or your third-party partners use this data for tracking?** No
- **Is this data required for the app to function, or can users choose to provide it?**
  - Email and username: Required
  - Location: Optional
  - Fitness activity: Optional (app works without logging climbs)
  - Usage data: Collected automatically, but anonymous

---

## 7. Submit for Review

1. In App Store Connect, under **Pricing and Availability**:
   - Set price to **Free**.
   - Set availability to **All Territories**.
2. Under **App Review Information**:
   - Sign-in required: Yes
   - Demo account email: test@boardsesh.com
   - Demo account password: test
   - Notes: Paste the review notes from the metadata doc.
3. Under **Version Release**:
   - Select **Manually release this version** (so you can control the launch timing).
4. Click **Submit for Review**.

---

## 8. Common Rejection Reasons and How to Avoid Them

### 4.2 Minimum Functionality (web wrapper)

Apple rejects apps that are just websites wrapped in a WebView without meaningful native functionality. This is a fully native React Native app — it renders native UI and has no web view at all — so the web-wrapper risk is weak. Our defense:

- **This is a native React Native app with no WebView.** The screens are native RN components, not a hosted website. There is no embedded browser anywhere in the app.
- **BLE is native-only and core to the app.** The app talks to Kilter Board and Tension Board hardware over native CoreBluetooth via `react-native-ble-plx`, which bridges to `CBCentralManager` (device discovery) and `CBPeripheral` (characteristic writes to the board's Nordic UART Service). There is no web fallback — Web Bluetooth is not supported on iOS (https://caniuse.com/web-bluetooth).
- The app declares `bluetooth-le` in `UIRequiredDeviceCapabilities` and `bluetooth-central` in `UIBackgroundModes`, signaling that BLE is core functionality.
- Include a screenshot of the Bluetooth pairing flow in the screenshots.
- If questioned, respond with: "This is a native React Native app with no web view. It requires native CoreBluetooth (via react-native-ble-plx) to communicate with Kilter Board hardware. Web Bluetooth is not supported on iOS. The app uses CBCentralManager to scan for boards advertising the Aurora BLE service (UUID 4488b571-7806-4df6-bcff-a2897e4953ff) and writes LED lighting commands to the Nordic UART RX characteristic (UUID 6e400002-b5a3-f393-e0a9-e50e24dcca9e). This functionality is not available in any iOS browser."

### 5.1.1(v) Account Deletion

Apple requires all apps with account creation to also support account deletion.

- Before submitting, verify that **Settings > Delete Account** works and fully removes the user's data.
- Test this with a throwaway account, not the demo account.

### 2.1 Performance (App Completeness)

- Test the app on a real device (not just simulator) before submitting.
- Make sure the app launches and reaches an interactive screen within a few seconds on a good network connection.
- The splash screen is configured by the `expo-splash-screen` plugin in `app.config.ts`; verify it dismisses cleanly once the first screen is ready.

### 2.5.1 Software Requirements

- Make sure the app does not crash on the latest iOS version.
- Test on the oldest iOS version you support (check `IPHONEOS_DEPLOYMENT_TARGET` in the Xcode project).

---

## 9. Post-Submission

- Apple reviews typically take **1 to 3 days**, sometimes faster.
- You will get an email if the app is approved or rejected.
- If approved with "Manually release" selected, go to App Store Connect and click "Release this version" when you are ready.

### If rejected

1. Read the rejection reason carefully. Apple usually cites a specific guideline number.
2. Fix the issue.
3. Upload a new build (increment the build number, not necessarily the version number).
4. Resubmit with a reply in the Resolution Center explaining what you changed.

### BLE-specific questions from review

Apple reviewers sometimes ask for more detail about Bluetooth usage. Be ready to explain:

- **Framework used:** Native CoreBluetooth, accessed via `react-native-ble-plx`. The native implementation uses `CBCentralManager` (Central role) and `CBPeripheral` for GATT operations.
- **Services and characteristics:** The app scans for devices advertising the Aurora service (UUID `4488b571-7806-4df6-bcff-a2897e4953ff`). After connecting, it discovers the Nordic UART Service (UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e`) and writes to the RX characteristic (UUID `6e400002-b5a3-f393-e0a9-e50e24dcca9e`).
- **Data direction:** One-way only — phone to board. The app sends LED lighting commands (hold positions and colors) so the board illuminates the correct holds for a climb.
- **No personal data:** No personal, health, or identifying information is transmitted over Bluetooth. Only LED position and color bytes.
- **Background mode:** The app declares `bluetooth-central` in `UIBackgroundModes` to maintain the BLE connection when the user briefly switches apps during a climbing session. No background scanning or reconnection is performed.
- **Device capability:** The app declares `bluetooth-le` in `UIRequiredDeviceCapabilities` because BLE board control is core functionality.

### After approval

- Monitor crash reports in App Store Connect > App Analytics.
- Update the `What's New` text for each new version.
- Subsequent updates go through the same build > upload > submit flow but are usually reviewed faster.
