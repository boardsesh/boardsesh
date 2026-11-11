#pragma once
/*
 * Boardsesh BLE usermod for WLED.
 *
 * UNBUILT AND UNTESTED. This file has never been compiled or run on a device.
 * It is reference source for docs/spray-wall-led-ble.md in the Boardsesh repo;
 * expect compile fixes against the exact WLED and NimBLE-Arduino versions used.
 *
 * Targets: WLED 0.15.x (registered in usermods_list.cpp) and newer WLED with
 * `custom_usermods` (registered by boardsesh_ble.cpp), on a classic ESP32
 * (Gledopto GL-C-015WL-D), with NimBLE-Arduino 1.4.x.
 *
 * What it does: exposes one GATT service. Each control frame is translated into
 * the WLED JSON state command the Boardsesh Wi-Fi driver would send and applied
 * with deserializeState() from WLED's own loop, so the BLE path and the Wi-Fi
 * path behave the same. No WLED core file is changed.
 *
 * Threading: NimBLE callbacks run on the NimBLE host task. They only copy the
 * frame into a FreeRTOS queue; WLED state is touched only in loop().
 */

#include "wled.h"

#ifndef ARDUINO_ARCH_ESP32
#error "The Boardsesh BLE usermod needs an ESP32 with Bluetooth."
#endif

#include <NimBLEDevice.h>
#include <freertos/queue.h>

#define BOARDSESH_BLE_SERVICE_UUID "7e100001-69ea-4190-8731-75eec7496aed"
#define BOARDSESH_BLE_INFO_UUID "7e100002-69ea-4190-8731-75eec7496aed"
#define BOARDSESH_BLE_CONTROL_UUID "7e100003-69ea-4190-8731-75eec7496aed"
#define BOARDSESH_BLE_STATUS_UUID "7e100004-69ea-4190-8731-75eec7496aed"

#define BOARDSESH_BLE_PROTOCOL_VERSION 1
#define BOARDSESH_BLE_MAX_FRAME 512
#define BOARDSESH_BLE_QUEUE_DEPTH 4
#define BOARDSESH_BLE_PAIRING_WINDOW_MS (10UL * 60UL * 1000UL)
#define BOARDSESH_BLE_INFO_REFRESH_MS 500UL
// Big enough for LIGHT_ALL over 32 segments or SET_PIXELS with 84 runs.
#define BOARDSESH_BLE_JSON_BYTES 8192

enum BoardseshBleOpcode : uint8_t {
  BS_OP_LIGHT_ALL = 0x10,
  BS_OP_OFF = 0x11,
  BS_OP_PREVIEW_BEGIN = 0x12,
  BS_OP_SET_PIXELS = 0x13,
  BS_OP_AUTO_OFF = 0x14,
  BS_OP_WAKE = 0x15,
};

enum BoardseshBleResult : uint8_t {
  BS_OK = 0,
  BS_UNSUPPORTED_VERSION = 1,
  BS_MALFORMED = 2,
  BS_OUT_OF_RANGE = 3,
  BS_BUSY = 4,
  BS_UNKNOWN_OPCODE = 5,
};

struct BoardseshBleFrame {
  uint16_t length;
  uint8_t data[BOARDSESH_BLE_MAX_FRAME];
};

class BoardseshBleUsermod;

class BoardseshBleServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit BoardseshBleServerCallbacks(BoardseshBleUsermod *owner) : owner(owner) {}
  void onConnect(NimBLEServer *server, ble_gap_conn_desc *desc) override;
  void onDisconnect(NimBLEServer *server) override;
  uint32_t onPassKeyRequest() override;
  void onAuthenticationComplete(ble_gap_conn_desc *desc) override;

 private:
  BoardseshBleUsermod *owner;
};

class BoardseshBleControlCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit BoardseshBleControlCallbacks(BoardseshBleUsermod *owner) : owner(owner) {}
  void onWrite(NimBLECharacteristic *characteristic) override;

 private:
  BoardseshBleUsermod *owner;
};

class BoardseshBleUsermod : public Usermod {
 public:
  // ---- settings (cfg.json, shown under Settings > Usermods) ----
  bool enabled = true;
  uint32_t passkey = 0;           // 6 digits; 0 means "pick one on boot"
  bool pairingOpen = true;        // on for BOARDSESH_BLE_PAIRING_WINDOW_MS after boot or after ticking it
  bool forgetAllPhones = false;   // one-shot: ticking it and saving deletes every bond

  // ---- runtime ----
  bool started = false;
  bool peerWasBonded = false;
  uint16_t peerHandle = 0;
  unsigned long pairingOpenedAt = 0;
  unsigned long lastInfoRefresh = 0;
  QueueHandle_t frames = nullptr;
  NimBLEServer *server = nullptr;
  NimBLECharacteristic *infoCharacteristic = nullptr;
  NimBLECharacteristic *controlCharacteristic = nullptr;
  NimBLECharacteristic *statusCharacteristic = nullptr;

  static const char _name[];

  void setup() override {
    if (!enabled) return;
    if (passkey == 0 || passkey > 999999) passkey = 100000 + (esp_random() % 900000);
    frames = xQueueCreate(BOARDSESH_BLE_QUEUE_DEPTH, sizeof(BoardseshBleFrame));
    if (!frames) return;
    startBle();
  }

  void connected() override {
    // ESP-IDF needs Wi-Fi modem sleep while Bluetooth runs (software coexistence).
    // WLED's "Disable WiFi sleep" turns it off when Wi-Fi connects; turn it back on.
    if (started) WiFi.setSleep(true);
  }

  void loop() override {
    if (!started) return;
    unsigned long now = millis();
    if (pairingOpen && now - pairingOpenedAt > BOARDSESH_BLE_PAIRING_WINDOW_MS) pairingOpen = false;
    if (now - lastInfoRefresh > BOARDSESH_BLE_INFO_REFRESH_MS) {
      lastInfoRefresh = now;
      refreshInfo();
    }
    static BoardseshBleFrame frame;  // 514 bytes: keep it off the loop task's stack
    while (xQueueReceive(frames, &frame, 0) == pdTRUE) {
      uint8_t result = applyFrame(frame.data, frame.length);
      notifyStatus(frame.length >= 3 ? frame.data[2] : 0, result);
    }
  }

  /** Called from the NimBLE host task: copy only. */
  void enqueue(const uint8_t *data, size_t length) {
    if (length < 3 || length > BOARDSESH_BLE_MAX_FRAME) {
      notifyStatus(length >= 3 ? data[2] : 0, BS_MALFORMED);
      return;
    }
    static BoardseshBleFrame incoming;  // only the host task writes here
    incoming.length = length;
    memcpy(incoming.data, data, length);
    if (xQueueSend(frames, &incoming, 0) != pdTRUE) notifyStatus(data[2], BS_BUSY);
  }

  void onPeerConnected(ble_gap_conn_desc *desc) {
    peerHandle = desc->conn_handle;
    peerWasBonded = NimBLEDevice::isBonded(NimBLEAddress(desc->peer_id_addr));
    // One phone at a time: NimBLE stops advertising on connect; keep it stopped.
  }

  void onPeerDisconnected() {
    peerHandle = 0;
    if (started) NimBLEDevice::startAdvertising();
  }

  void onPeerAuthenticated(ble_gap_conn_desc *desc) {
    bool secure = desc->sec_state.encrypted && desc->sec_state.authenticated;
    // A new phone may only bond while pairing is open; a known one always may.
    if (!secure || (!peerWasBonded && !pairingOpen)) {
      if (desc->sec_state.bonded && !peerWasBonded) NimBLEDevice::deleteBond(NimBLEAddress(desc->peer_id_addr));
      server->disconnect(desc->conn_handle);
    }
  }

  void addToJsonInfo(JsonObject &root) override {
    JsonObject user = root["u"];
    if (user.isNull()) user = root.createNestedObject("u");
    JsonArray line = user.createNestedArray(F("Boardsesh BLE"));
    if (!enabled) {
      line.add(F("disabled"));
      return;
    }
    line.add(started ? (peerHandle ? F("phone connected") : F("advertising")) : F("not started"));
    if (noWifiSleep) {
      JsonArray warning = user.createNestedArray(F("Boardsesh BLE Wi-Fi sleep"));
      warning.add(F("untick 'Disable WiFi sleep' (needed with Bluetooth)"));
    }
  }

  void addToConfig(JsonObject &root) override {
    JsonObject top = root.createNestedObject(FPSTR(_name));
    top[F("enabled")] = enabled;
    top[F("passkey")] = passkey;
    top[F("pairingOpen")] = pairingOpen;
    top[F("forgetAllPhones")] = false;
  }

  bool readFromConfig(JsonObject &root) override {
    JsonObject top = root[FPSTR(_name)];
    bool complete = !top.isNull();
    bool wasPairingOpen = pairingOpen;
    complete &= getJsonValue(top[F("enabled")], enabled, true);
    complete &= getJsonValue(top[F("passkey")], passkey, (uint32_t)0);
    complete &= getJsonValue(top[F("pairingOpen")], pairingOpen, true);
    getJsonValue(top[F("forgetAllPhones")], forgetAllPhones, false);
    if (passkey > 999999) passkey = 0;
    if (pairingOpen && (!wasPairingOpen || pairingOpenedAt == 0)) pairingOpenedAt = millis();
    if (started) {
      NimBLEDevice::setSecurityPasskey(passkey);
      if (forgetAllPhones) {
        NimBLEDevice::deleteAllBonds();
        if (peerHandle) server->disconnect(peerHandle);
      }
    }
    forgetAllPhones = false;
    return complete;
  }

  uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }

 private:
  void startBle() {
    NimBLEDevice::init(serverDescription);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);
    NimBLEDevice::setMTU(BOARDSESH_BLE_MAX_FRAME + 3 > 517 ? 517 : BOARDSESH_BLE_MAX_FRAME + 3);
    // Bonding + MITM + Secure Connections, with a static passkey the phone types.
    NimBLEDevice::setSecurityAuth(true, true, true);
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
    NimBLEDevice::setSecurityPasskey(passkey);

    server = NimBLEDevice::createServer();
    server->setCallbacks(new BoardseshBleServerCallbacks(this));
    NimBLEService *service = server->createService(BOARDSESH_BLE_SERVICE_UUID);
    infoCharacteristic = service->createCharacteristic(BOARDSESH_BLE_INFO_UUID, NIMBLE_PROPERTY::READ, 80);
    controlCharacteristic = service->createCharacteristic(
        BOARDSESH_BLE_CONTROL_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_ENC | NIMBLE_PROPERTY::WRITE_AUTHEN,
        BOARDSESH_BLE_MAX_FRAME);
    controlCharacteristic->setCallbacks(new BoardseshBleControlCallbacks(this));
    statusCharacteristic = service->createCharacteristic(
        BOARDSESH_BLE_STATUS_UUID,
        NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::READ_AUTHEN, 4);
    refreshInfo();
    service->start();

    NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
    advertising->addServiceUUID(BOARDSESH_BLE_SERVICE_UUID);
    advertising->setScanResponse(true);  // the name goes in the scan response
    advertising->start();
    started = true;
    // New phones can pair for a while after every boot, whatever cfg.json says.
    pairingOpen = true;
    pairingOpenedAt = millis();
    WiFi.setSleep(true);
  }

  void refreshInfo() {
    uint8_t value[80];
    uint16_t count = strip.getLengthTotal();
    size_t nameLength = strnlen(serverDescription, 32);
    size_t versionLength = strnlen(versionString, 32);
    value[0] = BOARDSESH_BLE_PROTOCOL_VERSION;
    value[1] = bri > 0 ? 1 : 0;  // WLED keeps bri at 0 while the strip is off
    value[2] = count & 0xff;
    value[3] = count >> 8;
    value[4] = BOARDSESH_BLE_MAX_FRAME & 0xff;
    value[5] = BOARDSESH_BLE_MAX_FRAME >> 8;
    size_t offset = 6;
    value[offset++] = nameLength;
    memcpy(value + offset, serverDescription, nameLength);
    offset += nameLength;
    value[offset++] = versionLength;
    memcpy(value + offset, versionString, versionLength);
    offset += versionLength;
    infoCharacteristic->setValue(value, offset);
  }

  void notifyStatus(uint8_t sequence, uint8_t result) {
    if (!statusCharacteristic) return;
    uint8_t value[4] = {BOARDSESH_BLE_PROTOCOL_VERSION, sequence, result, 0};
    statusCharacteristic->setValue(value, sizeof(value));
    statusCharacteristic->notify();
  }

  /** The Wi-Fi driver's segment reset, as JSON: segment 0 over the cable, solid `color`. */
  void addSegments(JsonObject state, uint16_t count, uint8_t red, uint8_t green, uint8_t blue, uint8_t white,
                   bool otherSegmentsOff) {
    JsonArray segments = state.createNestedArray("seg");
    for (uint8_t id = 0; id < strip.getSegmentsNum(); id++) {
      if (id != 0 && !strip.getSegment(id).isActive()) continue;
      JsonObject segment = segments.createNestedObject();
      segment["id"] = id;
      if (id != 0 && otherSegmentsOff) {
        segment["on"] = false;
        continue;
      }
      if (id == 0) {
        segment["start"] = 0;
        segment["stop"] = count;
      }
      segment["on"] = true;
      segment["bri"] = 255;
      segment["fx"] = 0;
      segment["pal"] = 0;
      segment["grp"] = 1;
      segment["spc"] = 0;
      segment["of"] = 0;
      segment["rev"] = false;
      segment["mi"] = false;
      segment["frz"] = false;
      JsonArray colors = segment.createNestedArray("col");
      JsonArray primary = colors.createNestedArray();
      primary.add(red);
      primary.add(green);
      primary.add(blue);
      primary.add(white);
    }
  }

  static void setNightlight(JsonObject state, uint8_t minutes) {
    JsonObject nightlight = state.createNestedObject("nl");
    nightlight["on"] = minutes > 0;
    if (minutes > 0) {
      nightlight["dur"] = minutes;
      nightlight["mode"] = 0;
      nightlight["tbri"] = 0;
    }
  }

  static void noSync(JsonObject state) { state.createNestedObject("udpn")["nn"] = true; }

  uint8_t applyFrame(const uint8_t *data, size_t length) {
    if (length < 3) return BS_MALFORMED;
    if (data[0] != BOARDSESH_BLE_PROTOCOL_VERSION) return BS_UNSUPPORTED_VERSION;
    const uint8_t opcode = data[1];
    const uint8_t *payload = data + 3;
    const size_t payloadLength = length - 3;
    const uint16_t count = strip.getLengthTotal();

    DynamicJsonDocument document(BOARDSESH_BLE_JSON_BYTES);
    JsonObject state = document.to<JsonObject>();
    switch (opcode) {
      case BS_OP_LIGHT_ALL:
        if (payloadLength != 2 || payload[0] == 0) return BS_MALFORMED;
        state["on"] = true;
        state["bri"] = payload[0];
        state["tt"] = 0;
        state["live"] = false;
        state["lor"] = 1;
        setNightlight(state, payload[1]);
        noSync(state);
        addSegments(state, count, 255, 255, 255, 255, false);
        break;
      case BS_OP_OFF:
        if (payloadLength != 0) return BS_MALFORMED;
        state["on"] = false;
        state["tt"] = 0;
        state["live"] = false;
        noSync(state);
        break;
      case BS_OP_PREVIEW_BEGIN: {
        if (payloadLength != 1 || payload[0] == 0) return BS_MALFORMED;
        state["on"] = true;
        state["bri"] = payload[0];
        state["tt"] = 0;
        state["live"] = false;
        state["lor"] = 1;
        setNightlight(state, 0);
        noSync(state);
        addSegments(state, count, 0, 0, 0, 0, true);
        // Individual colours are segment-relative: start the whole cable black.
        JsonArray individual = state["seg"][0].createNestedArray("i");
        individual.add(0);
        individual.add(count);
        individual.add("00000000");
        break;
      }
      case BS_OP_SET_PIXELS: {
        if (payloadLength == 0 || payloadLength % 6 != 0) return BS_MALFORMED;
        // Validate every run before applying any of them.
        for (size_t offset = 0; offset < payloadLength; offset += 6) {
          uint32_t start = payload[offset] | (payload[offset + 1] << 8);
          uint8_t runLength = payload[offset + 2];
          if (runLength == 0) return BS_MALFORMED;
          if (start + runLength > count) return BS_OUT_OF_RANGE;
        }
        state["tt"] = 0;
        noSync(state);
        JsonObject segment = state.createNestedArray("seg").createNestedObject();
        segment["id"] = 0;
        JsonArray individual = segment.createNestedArray("i");
        char hex[9];
        for (size_t offset = 0; offset < payloadLength; offset += 6) {
          uint16_t start = payload[offset] | (payload[offset + 1] << 8);
          uint8_t runLength = payload[offset + 2];
          // The fourth channel stays off so RGBW strips keep the route hues.
          snprintf(hex, sizeof(hex), "%02X%02X%02X00", payload[offset + 3], payload[offset + 4], payload[offset + 5]);
          if (runLength == 1) {
            individual.add(start);
          } else {
            individual.add(start);
            individual.add(start + runLength);
          }
          individual.add((char *)hex);  // non-const char*: ArduinoJson copies it
        }
        break;
      }
      case BS_OP_AUTO_OFF:
        if (payloadLength != 1) return BS_MALFORMED;
        setNightlight(state, payload[0]);
        break;
      case BS_OP_WAKE:
        if (payloadLength != 1 || payload[0] == 0) return BS_MALFORMED;
        state["on"] = true;
        state["bri"] = payload[0];
        state["tt"] = 0;
        setNightlight(state, 0);
        noSync(state);
        break;
      default:
        return BS_UNKNOWN_OPCODE;
    }
    if (document.overflowed()) return BS_MALFORMED;
    deserializeState(state, CALL_MODE_DIRECT_CHANGE);
    refreshInfo();
    return BS_OK;
  }
};

const char BoardseshBleUsermod::_name[] PROGMEM = "Boardsesh BLE";

inline void BoardseshBleServerCallbacks::onConnect(NimBLEServer *, ble_gap_conn_desc *desc) {
  owner->onPeerConnected(desc);
}
inline void BoardseshBleServerCallbacks::onDisconnect(NimBLEServer *) { owner->onPeerDisconnected(); }
inline uint32_t BoardseshBleServerCallbacks::onPassKeyRequest() { return owner->passkey; }
inline void BoardseshBleServerCallbacks::onAuthenticationComplete(ble_gap_conn_desc *desc) {
  owner->onPeerAuthenticated(desc);
}
inline void BoardseshBleControlCallbacks::onWrite(NimBLECharacteristic *characteristic) {
  NimBLEAttValue value = characteristic->getValue();
  owner->enqueue(value.data(), value.length());
}
