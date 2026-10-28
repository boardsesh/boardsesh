#pragma once
#include "Arduino.h"

#include <array>
#include <map>
#include <vector>
#define BLE_HS_CONN_HANDLE_NONE 65535
#define BLE_ADDR_RANDOM 1
#define BLE_HS_ADV_F_DISC_GEN 2
#define BLE_HS_ADV_F_BREDR_UNSUP 4
namespace NIMBLE_PROPERTY {
constexpr unsigned WRITE = 8, WRITE_NR = 4, NOTIFY = 16;
}
struct ble_addr_t {
    uint8_t type = 1;
    uint8_t val[6]{};
};
struct ble_gap_conn_desc {
    ble_addr_t our_ota_addr;
};
namespace fixture_ble_host {
inline bool synced = true;
inline std::array<bool, 3> active{}, configured{};
inline std::array<ble_addr_t, 3> addresses{};
inline std::map<uint16_t, ble_gap_conn_desc> peers;
}  // namespace fixture_ble_host
inline int ble_hs_synced() {
    return fixture_ble_host::synced;
}
inline int ble_gap_ext_adv_active(uint8_t index) {
    return fixture_ble_host::active[index];
}
inline int ble_gap_conn_find(uint16_t handle, ble_gap_conn_desc* desc) {
    auto found = fixture_ble_host::peers.find(handle);
    if (found == fixture_ble_host::peers.end())
        return 1;
    *desc = found->second;
    return 0;
}
class NimBLEAddress {
  public:
    ble_addr_t address;
    NimBLEAddress() = default;
    NimBLEAddress(ble_addr_t address) : address(address) {}
    NimBLEAddress(const uint8_t* bytes, uint8_t type) {
        address.type = type;
        // Match NimBLE's MSB-first byte-pointer constructor.
        for (size_t index = 0; index < 6; ++index)
            address.val[index] = bytes[5 - index];
    }
    bool operator==(const NimBLEAddress& other) const {
        return address.type == other.address.type && memcmp(address.val, other.address.val, 6) == 0;
    }
    bool operator!=(const NimBLEAddress& other) const { return !(*this == other); }
    std::string toString() const {
        char out[18];
        snprintf(out, sizeof(out), "%02x:%02x:%02x:%02x:%02x:%02x", address.val[5], address.val[4], address.val[3],
                 address.val[2], address.val[1], address.val[0]);
        return out;
    }
};
class NimBLEConnInfo {
  public:
    uint16_t handle;
    uint16_t getConnHandle() const { return handle; }
};
class NimBLEServer;
class NimBLECharacteristic;
class NimBLEServerCallbacks {
  public:
    virtual void onConnect(NimBLEServer*, NimBLEConnInfo&) {}
    virtual void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) {}
};
class NimBLECharacteristicCallbacks {
  public:
    virtual void onWrite(NimBLECharacteristic*, NimBLEConnInfo&) {}
};
class NimBLECharacteristic {
  public:
    NimBLECharacteristicCallbacks* callbacks = nullptr;
    std::vector<uint8_t> bytes;
    void setCallbacks(NimBLECharacteristicCallbacks* callbacks) { this->callbacks = callbacks; }
    std::vector<uint8_t> getValue() { return bytes; }
    void write(uint16_t handle, const std::vector<uint8_t>& value) {
        bytes = value;
        NimBLEConnInfo info{handle};
        callbacks->onWrite(this, info);
    }
};
class NimBLEService {
  public:
    std::map<std::string, NimBLECharacteristic> characteristics;
    NimBLECharacteristic* createCharacteristic(const char* uuid, unsigned, unsigned = 512) {
        return &characteristics[uuid];
    }
    NimBLECharacteristic* getCharacteristic(const char* uuid) {
        auto found = characteristics.find(uuid);
        return found == characteristics.end() ? nullptr : &found->second;
    }
    void start() {}
};
class NimBLEServer {
  public:
    NimBLEServerCallbacks* callbacks = nullptr;
    std::map<std::string, NimBLEService> services;
    void setCallbacks(NimBLEServerCallbacks* callbacks, bool) { this->callbacks = callbacks; }
    NimBLEService* createService(const char* uuid) { return &services[uuid]; }
    NimBLEService* getServiceByUUID(const char* uuid) {
        auto found = services.find(uuid);
        return found == services.end() ? nullptr : &found->second;
    }
    bool start() { return true; }
    unsigned getConnectedCount() const { return fixture_ble_host::peers.size(); }
    std::vector<uint16_t> getPeerDevices() const {
        std::vector<uint16_t> handles;
        for (auto& peer : fixture_ble_host::peers)
            handles.push_back(peer.first);
        return handles;
    }
    void disconnect(uint16_t handle) {
        if (fixture_ble_host::peers.erase(handle)) {
            NimBLEConnInfo info{handle};
            callbacks->onDisconnect(this, info, 0);
        }
    }
    void connect(size_t board, uint16_t handle) {
        fixture_ble_host::peers[handle] = {fixture_ble_host::addresses[board]};
        fixture_ble_host::active[board] = false;
        NimBLEConnInfo info{handle};
        callbacks->onConnect(this, info);
    }
};
class NimBLEExtAdvertisement {
  public:
    NimBLEAddress address;
    void setLegacyAdvertising(bool) {}
    void setConnectable(bool) {}
    void setScannable(bool) {}
    void setAddress(NimBLEAddress address) { this->address = address; }
    void setFlags(unsigned) {}
    void addServiceUUID(const char*) {}
    void setName(const char*) {}
};
class NimBLEExtAdvertising {
  public:
    bool stop(size_t index) {
        fixture_ble_host::active[index] = false;
        return true;
    }
    bool removeInstance(size_t index) {
        fixture_ble_host::configured[index] = false;
        return true;
    }
    bool setInstanceData(size_t index, NimBLEExtAdvertisement& advertisement) {
        fixture_ble_host::configured[index] = true;
        fixture_ble_host::addresses[index] = advertisement.address.address;
        return true;
    }
    bool setScanResponseData(size_t, NimBLEExtAdvertisement&) { return true; }
    bool start(size_t index) {
        if (!fixture_ble_host::synced || !fixture_ble_host::configured[index])
            return false;
        fixture_ble_host::active[index] = true;
        return true;
    }
};
class NimBLEDevice {
  public:
    inline static NimBLEServer server;
    inline static NimBLEExtAdvertising advertising;
    static bool init(const std::string&) { return true; }
    static void setMTU(int) {}
    static NimBLEServer* createServer() { return &server; }
    static NimBLEExtAdvertising* getAdvertising() { return &advertising; }
};
