// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifdef EMULATOR_BUILD

#include "ble_emulator.h"

#include <NimBLEDevice.h>

namespace {

// Aurora advertised service UUID — phone-side scan filter for
// kilter/tension/decoy/touchstone/grasshopper looks for this.
constexpr const char* AURORA_ADVERTISED_SERVICE = "4488b571-7806-4df6-bcff-a2897e4953ff";

// Nordic UART service: where the phone writes the LED payload.
constexpr const char* UART_SERVICE_UUID    = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr const char* UART_WRITE_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

NimBLEServer*         gServer        = nullptr;
NimBLEService*        gAuroraService = nullptr;
NimBLEService*        gUartService   = nullptr;
NimBLECharacteristic* gWriteChar     = nullptr;
NimBLEAdvertising*    gAdvertising   = nullptr;

class WriteCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* c) override {
        std::string val = c->getValue();
        if (val.empty()) return;
        // Log the first few bytes so we can confirm protocol-level traffic
        // from the serial console without needing the web UI to be working.
        // Aurora frames begin with 0x01 (SOH); MoonBoard frames begin with 'l' (0x6C).
        Serial.printf("[BLE] write %u bytes: ", static_cast<unsigned>(val.size()));
        const size_t shown = val.size() < 16 ? val.size() : 16;
        for (size_t i = 0; i < shown; ++i) Serial.printf("%02x ", static_cast<uint8_t>(val[i]));
        if (val.size() > shown) Serial.print("...");
        Serial.println();
        bleEmulator.emitWrite(reinterpret_cast<const uint8_t*>(val.data()), val.size());
    }
};

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* /*s*/) override {
        Serial.println("[BLE] Central connected");
        bleEmulator.emitConnection(true);
    }
    void onDisconnect(NimBLEServer* /*s*/) override {
        Serial.println("[BLE] Central disconnected — restarting advertising");
        bleEmulator.emitConnection(false);
        if (gAdvertising) gAdvertising->start();
    }
};

WriteCallbacks  gWriteCb;
ServerCallbacks gServerCb;

}  // namespace

BleEmulator bleEmulator;

String BleEmulator::boardToString(EmulatedBoard b) {
    switch (b) {
        case EmulatedBoard::KILTER:      return "kilter";
        case EmulatedBoard::TENSION:     return "tension";
        case EmulatedBoard::DECOY:       return "decoy";
        case EmulatedBoard::TOUCHSTONE:  return "touchstone";
        case EmulatedBoard::GRASSHOPPER: return "grasshopper";
        case EmulatedBoard::MOONBOARD:   return "moonboard";
    }
    return "kilter";
}

bool BleEmulator::parseBoard(const String& s, EmulatedBoard& out) {
    String l = s;
    l.toLowerCase();
    if (l == "kilter")      { out = EmulatedBoard::KILTER;      return true; }
    if (l == "tension")     { out = EmulatedBoard::TENSION;     return true; }
    if (l == "decoy")       { out = EmulatedBoard::DECOY;       return true; }
    if (l == "touchstone")  { out = EmulatedBoard::TOUCHSTONE;  return true; }
    if (l == "grasshopper") { out = EmulatedBoard::GRASSHOPPER; return true; }
    if (l == "moonboard")   { out = EmulatedBoard::MOONBOARD;   return true; }
    return false;
}

String BleEmulator::buildLocalName(const EmulatorConfig& cfg) {
    if (cfg.board == EmulatedBoard::MOONBOARD) {
        return String("MoonBoard ") + (cfg.serial.length() ? cfg.serial : String("A"));
    }
    String prefix;
    switch (cfg.board) {
        case EmulatedBoard::KILTER:      prefix = "Kilter Board";      break;
        case EmulatedBoard::TENSION:     prefix = "Tension Board";     break;
        case EmulatedBoard::DECOY:       prefix = "Decoy Board";       break;
        case EmulatedBoard::TOUCHSTONE:  prefix = "Touchstone Board";  break;
        case EmulatedBoard::GRASSHOPPER: prefix = "Grasshopper Board"; break;
        default: prefix = "Kilter Board"; break;
    }
    return prefix + "#" + cfg.serial + "@" + String(cfg.apiLevel);
}

bool BleEmulator::begin(const EmulatorConfig& config) {
    currentConfig = config;

    NimBLEDevice::init(buildLocalName(config).c_str());
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    gServer = NimBLEDevice::createServer();
    gServer->setCallbacks(&gServerCb);

    gAuroraService = gServer->createService(AURORA_ADVERTISED_SERVICE);
    gAuroraService->start();

    gUartService = gServer->createService(UART_SERVICE_UUID);
    gWriteChar = gUartService->createCharacteristic(
        UART_WRITE_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    gWriteChar->setCallbacks(&gWriteCb);
    gUartService->start();

    rebuildAdvertising();
    Serial.printf("[BLE] Advertising as: %s\n", buildLocalName(config).c_str());
    return true;
}

void BleEmulator::setConfig(const EmulatorConfig& config) {
    currentConfig = config;
    if (gAdvertising) gAdvertising->stop();

    // While a central is connected the phone-side BLE stack keeps the cached
    // device name from the moment it paired. Switching board type (e.g.
    // Kilter → Tension) without dropping the connection means the phone keeps
    // reading the old name from the GAP service and never rediscovers under
    // the new identity. Disconnecting all peers forces a clean re-pair so the
    // phone sees the new advertising data.
    if (gServer) {
        const size_t count = gServer->getConnectedCount();
        for (size_t i = 0; i < count; ++i) {
            NimBLEConnInfo info = gServer->getPeerInfo(i);
            gServer->disconnect(info.getConnHandle());
        }
    }

    NimBLEDevice::setDeviceName(buildLocalName(config).c_str());
    rebuildAdvertising();
    Serial.printf("[BLE] Re-advertising as: %s\n", buildLocalName(config).c_str());
}

void BleEmulator::rebuildAdvertising() {
    gAdvertising = NimBLEDevice::getAdvertising();
    gAdvertising->reset();

    const String localName = buildLocalName(currentConfig);
    const char* serviceUuid = currentConfig.board == EmulatedBoard::MOONBOARD
                                  ? UART_SERVICE_UUID
                                  : AURORA_ADVERTISED_SERVICE;

    // BLE primary advertising data is capped at 31 bytes total. Aurora names
    // ("Kilter Board#751737@3" = 21 chars → 23-byte AD field) plus a 16-byte
    // service-UUID AD field (18 bytes) overflows. NimBLE silently drops the
    // name when this happens — which means the phone-side MoonBoard scan
    // filter (`namePrefix: 'MoonBoard'`) never matches and the device is
    // invisible. Fix: keep flags + service UUID in primary adv, push the full
    // name into the scan response packet (also 31 bytes, but on its own).
    NimBLEAdvertisementData advData;
    advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
    advData.setCompleteServices(NimBLEUUID(serviceUuid));
    gAdvertising->setAdvertisementData(advData);

    NimBLEAdvertisementData scanResp;
    scanResp.setName(localName.c_str());
    gAdvertising->setScanResponseData(scanResp);

    gAdvertising->setScanResponse(true);
    gAdvertising->start();
}

#endif // EMULATOR_BUILD
