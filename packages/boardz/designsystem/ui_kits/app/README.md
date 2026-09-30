# Boardz app UI kit

`index.html` is a click-through of the app. Use the device switcher (phone / tablet / desktop) and the theme switcher at the top. Everything is fake data (`data.js`).

Try: Connect board → open a problem → Light it up → Log → Flash. You can also use the filters, favorites, lists, rankings periods, history and settings (grade scale, mirror, theme).

- `Shell.jsx`: NAV, Wordmark, TopBar, Sidebar (desktop), Rail (tablet)
- `ProblemsScreen.jsx`: ProblemList, FiltersSheet
- `ProblemDetail.jsx`: ProblemDetail (board, beta, ascents, info), LogSheet
- `OtherScreens.jsx`: Lists, Rankings, History, Settings, ConnectSheet

All screens are composed from `window.Boardz` components.
