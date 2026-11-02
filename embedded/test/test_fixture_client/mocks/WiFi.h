#pragma once

inline constexpr int WL_CONNECTED = 3;
inline constexpr int WL_DISCONNECTED = 6;
struct FixtureClientWiFi {
    int connectionStatus = WL_CONNECTED;
    int status() const { return connectionStatus; }
};
inline FixtureClientWiFi WiFi;
