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

## 2. Capture and review store assets

The standard native capture uses recorded fixtures and the app's dark appearance:

```bash
vp run mobile:screenshots -- --platform ios --fixtures replay --theme dark --devices common --locales all
```

This replays the pinned fixture rather than depending on changing production
content. It writes framed PNGs to
`app-stores/apple/screenshots/<app-store-locale>/<device>/` and retains the
native sources under `app-stores/apple/raw-screenshots/`. See the
[iOS capture guide](../../docs/ios-simulator-screenshots.md) for simulator and
cached native-client prerequisites, and the [fixture guide](../../docs/mobile-screenshot-fixtures.md)
for capture data.

### Device and language coverage

| Capture device        | Native output | Orientation |
| --------------------- | ------------- | ----------- |
| iPhone 16 Pro Max     | 1320 × 2868   | Portrait    |
| iPhone 16 Pro         | 1206 × 2622   | Portrait    |
| iPad Pro 13-inch (M5) | 2752 × 2064   | Landscape   |
| iPad Pro 11-inch (M5) | 2420 × 1668   | Landscape   |

The common matrix captures both iPhone display sizes and both iPads. The
four app languages (`en-US`, `es`, `fr`, `de`) produce 16 capture shards and
20 storefront sets: Spanish supplies both `es-ES` and `es-MX`, while French and
German map to `fr-FR` and `de-DE`. iPad has its own six-image kiosk-first story.
Use the actual PNG dimensions and the repository's dimension gate to verify
slot assignment. [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)

### New nine-image iPhone campaign

The new story leads with Kilter, Tension and MoonBoard together, then the shared
queue, spray walls, additional supported boards, wall status, logbook, workouts,
Dynamic Island and climb search. Its full output map is in
[App Store metadata](app-store-metadata.md#screenshots).

It is an opt-in local flow until the required fixture is ready:

```bash
vp run mobile:screenshots -- --platform ios --flow app-store-campaign --fixtures replay --fixtures-dir <verified-campaign-fixture> --theme dark --devices common --locales all
```

Replace the placeholder with a verified, sanitized replay fixture containing a
shared crew session and seven board selectors in order: Kilter, Tension,
MoonBoard, Woods, Decoy, Grasshopper, spray. The pinned legacy fixture lacks the
required Decoy/spray scenario. The campaign checks board types and fails before
capture if that prerequisite is absent. Do not replace missing boards with other
captures or bypass the check.

This flow writes to `app-stores/app-store-campaign/apple/`, preserving its
18-source iPhone captures under `raw-screenshots/` and its nine-image sets under
`screenshots/`. iPads retain their existing six-image recipe. Review the entire
campaign before staging a complete locale/device set into the canonical
`app-stores/apple/screenshots/` upload tree. The default `app-store` flow still
produces the earlier ten-image iPhone set; the workflow does not select the new
campaign automatically.

### Review before uploading

1. Inspect each contact sheet at store thumbnail size; confirm board labels and readable copy.
2. Inspect full-size images for missing holds, loading states and obscured controls.
3. Check Spanish, French and German text, including the captured native UI.
4. Verify the shared queue, distinct on-wall status and real Dynamic Island controls.
5. Run the complete screenshot dimension and content gates before staging an upload.

Only real app captures and permitted wall photography belong in these assets;
do not generate app screenshots with AI. Keep the source PNGs and presentation
manifests so a reviewer can trace each composition.

### Screenshot upload to App Store Connect

The **Mobile Screenshots (iOS)** workflow's manual dispatch defaults to capture
only (`upload = false`, `publish_baseline = false`). Inspect the artifact before
requesting an upload. Automatic runs after a qualifying native release-train
build can upload a complete verified default set; see the
[release workflow](../../docs/mobile-store-release.md) before dispatching.

`fastlane ios screenshots` uploads only the staged screenshot tree, with
`skip_binary_upload`, `skip_metadata` and `submit_for_review: false`. Filename
prefixes determine image order; pixel dimensions determine the display slot.
The lane skips when no editable App Store version exists. Check App Store
Connect's current version and status immediately before upload: a successful
TestFlight build or earlier draft-preparation run does not prove it is editable
now. The lane does not create a new version or submit it for review.

The lane synchronizes the entire screenshot set with the supplied PNGs. Use a
complete reviewed set, because an upload replaces the existing images in its
slots. Authentication uses the existing App Store Connect API key; local lane
instructions are in [fastlane/README.md](../../fastlane/README.md).

### Header and Search Results stills

Generate these separately from screenshots:

```bash
vp run store:creatives -- --input <rawdevice> --output .boardsesh/app-store-creatives/en-US --device iphone-16-pro --locale en-US
```

The command writes opaque `header.png` (3840 × 1646), `search-results.png`
(3840 × 2560) and `creative-assets.json` provenance. Replace `<rawdevice>` with
the matching locale/device directory of native captures. Repeat for `es`, `fr`
and `de`; do not relabel English UI as a localized capture. These files stay
outside the screenshot upload tree and are not uploaded by fastlane's screenshot
or metadata lanes.

Header and Search Results are organic App Store creative placements on
iOS/iPadOS 27 and later. Review and submit them through App Store Connect's
Asset Library, then assign the approved assets to the intended version and
localizations. See the [creative asset runbook](../../docs/app-store-creative-assets.md)
for the manual review/publication sequence. Do not infer Apple Ads placement
eligibility from the presence of these organic assets.

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

The React Native workflow uploads the archive during export, so there is no
manual Xcode Organizer upload step in the normal release path. Use Organizer only
for an emergency local archive after recreating the same `packages/mobile/ios`
prebuild inputs.

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
- If the reviewer needs pairing evidence, attach a real capture to the review notes; keep the public nine-image campaign focused on its approved story.
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
