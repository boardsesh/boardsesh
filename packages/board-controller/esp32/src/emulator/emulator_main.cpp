#ifdef EMULATOR_BUILD

#include "emulator_main.h"

#include <Arduino.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <ctype.h>

#include "ble_emulator.h"
#include "ws_server.h"

#ifndef EMULATOR_WIFI_SSID
#define EMULATOR_WIFI_SSID ""
#endif
#ifndef EMULATOR_WIFI_PASS
#define EMULATOR_WIFI_PASS ""
#endif

namespace {

constexpr const char* NVS_NAMESPACE = "emul";
constexpr uint16_t WS_PORT = 81;
Preferences gPrefs;
bool gMdnsStarted = false;

EmulatorConfig loadConfig() {
    EmulatorConfig cfg;
    if (!gPrefs.begin(NVS_NAMESPACE, true)) return cfg;
    String boardStr = gPrefs.getString("board", "kilter");
    EmulatedBoard b;
    if (BleEmulator::parseBoard(boardStr, b)) cfg.board = b;
    cfg.serial   = gPrefs.getString("serial", "751737");
    cfg.apiLevel = static_cast<uint8_t>(gPrefs.getUChar("apiLevel", 3));
    gPrefs.end();
    return cfg;
}

void saveConfig(const EmulatorConfig& cfg) {
    if (!gPrefs.begin(NVS_NAMESPACE, false)) return;
    gPrefs.putString("board", BleEmulator::boardToString(cfg.board));
    gPrefs.putString("serial", cfg.serial);
    gPrefs.putUChar("apiLevel", cfg.apiLevel);
    gPrefs.end();
}

String buildMdnsHostName(const String& deviceName, const String& macAddress) {
    String base;
    bool lastWasDash = false;

    for (size_t i = 0; i < deviceName.length(); i++) {
        char c = static_cast<char>(tolower(deviceName[i]));
        bool isAlphaNumeric = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (isAlphaNumeric) {
            base += c;
            lastWasDash = false;
        } else if (!lastWasDash && base.length() > 0) {
            base += '-';
            lastWasDash = true;
        }
    }

    while (base.endsWith("-")) {
        base.remove(base.length() - 1);
    }

    String macSuffix;
    for (size_t i = 0; i < macAddress.length(); i++) {
        char c = static_cast<char>(tolower(macAddress[i]));
        if ((c >= 'a' && c <= 'f') || (c >= '0' && c <= '9')) {
            macSuffix += c;
        }
    }
    if (macSuffix.length() > 6) {
        macSuffix = macSuffix.substring(macSuffix.length() - 6);
    }

    if (base.length() == 0) {
        base = "boardsesh-esp32";
    }

    const size_t suffixLength = macSuffix.length() > 0 ? macSuffix.length() + 1 : 0;
    const size_t maxBaseLength = 63 - suffixLength;
    if (base.length() > maxBaseLength) {
        base = base.substring(0, maxBaseLength);
        while (base.endsWith("-")) {
            base.remove(base.length() - 1);
        }
    }

    if (macSuffix.length() > 0) {
        base += "-";
        base += macSuffix;
    }

    return base;
}

void stopMdns() {
    if (!gMdnsStarted) {
        return;
    }
    MDNS.end();
    gMdnsStarted = false;
    wsServer.setMdnsHost("");
}

void startMdns(const EmulatorConfig& cfg) {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    stopMdns();

    const String hostName = buildMdnsHostName(BleEmulator::buildLocalName(cfg), WiFi.macAddress());
    if (!MDNS.begin(hostName.c_str())) {
        Serial.printf("[mDNS] Failed to start %s.local\n", hostName.c_str());
        return;
    }

    MDNS.addService("boardsesh", "tcp", WS_PORT);
    MDNS.addServiceTxt("boardsesh", "tcp", "role", "emulator");
    const String boardName = BleEmulator::boardToString(cfg.board);
    MDNS.addServiceTxt("boardsesh", "tcp", "board", boardName.c_str());
    wsServer.setMdnsHost(hostName + ".local");
    gMdnsStarted = true;
    Serial.printf("[mDNS] %s.local\n", hostName.c_str());
}

void connectWifi() {
    const char* ssid = EMULATOR_WIFI_SSID;
    const char* pass = EMULATOR_WIFI_PASS;
    if (strlen(ssid) == 0) {
        Serial.println("[WiFi] EMULATOR_WIFI_SSID empty — set it in packages/board-controller/esp32/.env");
        return;
    }
    Serial.printf("[WiFi] Connecting to '%s'...\n", ssid);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, pass);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && (millis() - start) < 30000) {
        delay(250);
        Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("[WiFi] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("[WiFi] Connect timed out — emulator will retry from loop().");
    }
}

void maintainWifi() {
    static unsigned long lastAttempt = 0;
    if (WiFi.status() == WL_CONNECTED) return;
    unsigned long now = millis();
    if (now - lastAttempt < 10000) return;
    lastAttempt = now;
    Serial.println("[WiFi] Reconnecting...");
    WiFi.reconnect();
}

}  // namespace

// True once we've started the WS server, which we defer until Wi-Fi is up.
// Starting the WebSocketsServer before lwIP is initialised hard-asserts in
// tcpip_send_msg_wait_sem (Invalid mbox), so we gate it on WiFi.status().
bool gWsStarted = false;

void emulatorSetup() {
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("===============================");
    Serial.println("  BoardSesh ESP32 EMULATOR");
    Serial.println("===============================");

    EmulatorConfig cfg = loadConfig();

    connectWifi();

    bleEmulator.setOnWrite([](const uint8_t* data, size_t length) {
        if (gWsStarted) wsServer.broadcastBleWrite(data, length);
    });
    bleEmulator.setOnConnectionChange([](bool connected) {
        if (gWsStarted) wsServer.broadcastBleConnection(connected);
    });
    bleEmulator.begin(cfg);

    wsServer.setOnConfigChange([](const EmulatorConfig& newCfg) {
        bleEmulator.setConfig(newCfg);
        saveConfig(newCfg);
        startMdns(newCfg);
    });

    if (WiFi.status() == WL_CONNECTED) {
        startMdns(cfg);
        wsServer.begin(WS_PORT);
        gWsStarted = true;
        Serial.println("===============================");
        Serial.printf("  Ready. WS: ws://%s:%u/\n", WiFi.localIP().toString().c_str(),
                      static_cast<unsigned>(WS_PORT));
        Serial.printf("  BLE:    %s\n", BleEmulator::buildLocalName(cfg).c_str());
        Serial.println("===============================");
    } else {
        Serial.println("===============================");
        Serial.printf("  BLE up: %s\n", BleEmulator::buildLocalName(cfg).c_str());
        Serial.println("  WS:    waiting for Wi-Fi…");
        Serial.println("===============================");
    }
}

void emulatorLoop() {
    maintainWifi();

    if (WiFi.status() != WL_CONNECTED) {
        stopMdns();
    } else if (!gMdnsStarted) {
        startMdns(bleEmulator.getConfig());
    }

    // Lazy-start the WS server the first time Wi-Fi comes up.
    if (!gWsStarted && WiFi.status() == WL_CONNECTED) {
        wsServer.begin(WS_PORT);
        gWsStarted = true;
        Serial.printf("[WS] Started: ws://%s:%u/\n", WiFi.localIP().toString().c_str(),
                      static_cast<unsigned>(WS_PORT));
    }
    if (gWsStarted) wsServer.loop();
    delay(1);
}

#endif // EMULATOR_BUILD
