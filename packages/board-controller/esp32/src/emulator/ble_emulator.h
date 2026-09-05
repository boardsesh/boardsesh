// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef BLE_EMULATOR_H
#define BLE_EMULATOR_H

#ifdef EMULATOR_BUILD

#include <Arduino.h>
#include <functional>

enum class EmulatedBoard {
    KILTER,
    TENSION,
    DECOY,
    TOUCHSTONE,
    GRASSHOPPER,
    MOONBOARD,
};

struct EmulatorConfig {
    EmulatedBoard board = EmulatedBoard::KILTER;
    String serial = "751737";
    uint8_t apiLevel = 3;  // 2 or 3 (ignored for moonboard)
};

// Buffer is valid only for the duration of the callback — copy if needed.
using BleWriteCallback = std::function<void(const uint8_t* data, size_t length)>;
using BleConnectionCallback = std::function<void(bool connected)>;

class BleEmulator {
public:
    bool begin(const EmulatorConfig& config);
    void setConfig(const EmulatorConfig& config);
    EmulatorConfig getConfig() const { return currentConfig; }

    void setOnWrite(BleWriteCallback cb) { onWrite = std::move(cb); }
    void setOnConnectionChange(BleConnectionCallback cb) { onConn = std::move(cb); }

    // Public so file-scope NimBLE callbacks can bridge into us. Not intended
    // for callers other than the BLE callback shims in ble_emulator.cpp.
    void emitWrite(const uint8_t* data, size_t length) { if (onWrite) onWrite(data, length); }
    void emitConnection(bool connected) { if (onConn) onConn(connected); }

    static String boardToString(EmulatedBoard b);
    static bool parseBoard(const String& s, EmulatedBoard& out);
    static String buildLocalName(const EmulatorConfig& cfg);

private:
    void rebuildAdvertising();
    EmulatorConfig currentConfig;
    BleWriteCallback onWrite;
    BleConnectionCallback onConn;
};

extern BleEmulator bleEmulator;

#endif // EMULATOR_BUILD
#endif // BLE_EMULATOR_H
