# Boardsesh Web App UI Specification for React Native Rewrite

## Purpose

This directory is the single source of truth for agents building the React Native app. Every screen, interaction, and data flow from the web app is documented so agents can validate their mobile implementations against the exact behavior of the production web application.

## How to Use

Each file covers one domain. Load only the file(s) relevant to the feature you're building. Every section includes layout, user actions, data sources, states, and navigation. Follow the documented behavior exactly -- do not invent new patterns.

When the web app uses a web-specific technology (CSS Grid, MUI components, browser APIs), the corresponding React Native adaptation is noted under **Mobile adaptation notes** in each file.

## Spec Files

| File                                               | Domain            | Lines | Description                                                                     |
| -------------------------------------------------- | ----------------- | ----- | ------------------------------------------------------------------------------- |
| [00-overview.md](00-overview.md)                   | Overview          | —     | This file. Component mapping table, how to use the spec.                        |
| [01-navigation.md](01-navigation.md)               | Navigation        | 174   | Tab bar, headers, drawer/sheet system, deep linking, auth gating                |
| [02-home.md](02-home.md)                           | Home              | 85    | Landing page: hero, board discovery, beta videos, onboarding cards              |
| [03-auth.md](03-auth.md)                           | Auth              | 125   | Login, signup, verify email, OAuth, native start                                |
| [04-board-selection.md](04-board-selection.md)     | Board Selection   | 147   | Map search, my boards, popular configs, custom board creation                   |
| [05-climb-list.md](05-climb-list.md)               | Climb List        | 172   | Browse climbs: grid/list, search, filters, infinite scroll                      |
| [06-play-view.md](06-play-view.md)                 | Play View         | 545   | Board carousel, swipe nav, zoom/pan, actions, tick, state machine               |
| [07-climb-detail.md](07-climb-detail.md)           | Climb Detail      | 93    | Info view: collapsible sections, comments, stats, beta videos                   |
| [08-create-climb.md](08-create-climb.md)           | Create Climb      | 133   | Hold editor, form, draft save, BLE preview, MoonBoard import                    |
| [09-queue-control-bar.md](09-queue-control-bar.md) | Queue Control Bar | 775   | Persistent bar: swipe nav, quick tick, session header, queue list               |
| [10-session.md](10-session.md)                     | Session           | 216   | Create, join, details, summary, settings                                        |
| [11-party-mode.md](11-party-mode.md)               | Party Mode        | 114   | Always-live wall control, wall confirmation, participant tracking, angle sync   |
| [12-bluetooth.md](12-bluetooth.md)                 | Bluetooth         | 136   | BLE connect, frame sending, light control, disconnect handling                  |
| [13-onboarding.md](13-onboarding.md)               | Onboarding        | 124   | 15-step guided tour overlay with state management                               |
| [14-playlists.md](14-playlists.md)                 | Playlists         | 147   | Library, detail, create/edit, smart playlists, discover                         |
| [15-profile.md](15-profile.md)                     | Profile           | 102   | Own/public profile, stats, sessions, climbs, personal dashboard                 |
| [16-feed.md](16-feed.md)                           | Feed              | 88    | Sessions, proposals, comments tabs, board filter                                |
| [17-notifications.md](17-notifications.md)         | Notifications     | 70    | Grouped list, notification types, mark as read, real-time                       |
| [18-settings.md](18-settings.md)                   | Settings          | 165   | Profile, preferences, password, Aurora linking, controllers, delete             |
| [19-logbook.md](19-logbook.md)                     | Logbook           | 103   | Ascent list, tick logging, filters, edit/delete, crew logbook                   |
| [20-shared-patterns.md](20-shared-patterns.md)     | Shared Patterns   | 165   | Empty states, loading, swipe actions, toasts, grade tints                       |
| [21-data-layer.md](21-data-layer.md)               | Data Layer        | 112   | GraphQL ops per screen + mobile gap analysis (15 built, 4 partial, 40+ missing) |

## Web-to-Mobile Component Mapping

| Web Component                                     | React Native Equivalent                                                   | Notes                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| MUI `Button` / `IconButton`                       | RN `Pressable` with theme styling                                         | Use `hitSlop` for small targets. Match active/disabled opacity from theme tokens.  |
| MUI `TextField`                                   | RN `TextInput`                                                            | White background in dark mode (matches web's `darkTokens.semantic.inputSurface`).  |
| MUI `Dialog`                                      | `@gorhom/bottom-sheet` `BottomSheetModal`                                 | All web dialogs are already bottom-sheet drawers; map 1:1.                         |
| MUI `Drawer` / `SwipeableDrawer`                  | `@gorhom/bottom-sheet` `BottomSheetModal`                                 | Swipe-to-dismiss, drag handle, backdrop tap to close.                              |
| MUI `Snackbar`                                    | Toast notification system                                                 | Use `react-native-toast-message` or equivalent. Auto-dismiss after 4000ms default. |
| MUI `Avatar`                                      | Custom `Avatar` component with fallback initials                          | Circle with image or two-letter initials.                                          |
| MUI `Chip` / `Badge`                              | Custom `Badge` component                                                  | Pill-shaped for chips, dot or count for badges.                                    |
| CSS Grid / Flexbox                                | RN Flexbox (no CSS Grid in RN)                                            | All grid layouts must be converted to nested flex containers.                      |
| `@tanstack/react-virtual`                         | `@shopify/flash-list`                                                     | Virtual list with `estimatedItemSize`. List mode uses 107px estimate.              |
| Next.js App Router                                | Expo Router file-based routing                                            | `packages/mobile/app/` directory mirrors web route structure.                      |
| IndexedDB                                         | `expo-secure-store` (credentials) + `AsyncStorage` (preferences)          | Secure store for tokens; AsyncStorage for view mode, last-used board, etc.         |
| Web Bluetooth API                                 | `react-native-ble-plx`                                                    | Direct BLE access on native. No Bluefy workaround needed.                          |
| CSS media queries                                 | Platform-specific code + `Dimensions` API                                 | Use `Platform.select()` and `useWindowDimensions()`.                               |
| SVG (`react-svg`)                                 | `react-native-svg`                                                        | Board renderer, hold overlays, climb thumbnails.                                   |
| Infinite scroll sentinel (`IntersectionObserver`) | `onEndReached` on FlashList/FlatList                                      | Set `onEndReachedThreshold` to 0.5 (roughly 5 items before end).                   |
| MUI `Tabs`                                        | Custom segmented control or `react-native-pager-view`                     | Swipeable tab views for login/register.                                            |
| MUI `Select` / `MenuItem`                         | `@react-native-picker/picker` or custom bottom-sheet picker               | Board config selects, angle selector.                                              |
| MUI `Switch`                                      | RN `Switch`                                                               | Draft toggle, heatmap toggle, filter switches.                                     |
| MUI `Slider`                                      | `@react-native-community/slider`                                          | Grade range picker (if slider variant used).                                       |
| MUI `Popover`                                     | `@gorhom/bottom-sheet` or custom positioned view                          | Hold type picker anchored to tapped hold.                                          |
| MUI `Accordion` / `CollapsibleSection`            | Custom animated collapsible with `react-native-reanimated`                | Search filters, climb detail sections.                                             |
| `next/image`                                      | RN `Image` with `expo-image` for caching                                  | Use `expo-image` for optimized loading and caching.                                |
| Leaflet map                                       | `react-native-maps`                                                       | Board search map with markers.                                                     |
| CSS `backdrop-filter: blur()`                     | `expo-blur` `BlurView`                                                    | Tab bar frosted glass effect.                                                      |
| `react-i18next` `useTranslation`                  | Mobile i18n provider at `packages/mobile/src/providers/i18n-provider.tsx` | Same catalog structure, different provider.                                        |
