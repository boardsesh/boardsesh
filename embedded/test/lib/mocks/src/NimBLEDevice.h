/**
 * NimBLE Mock Header for Native Unit Testing
 *
 * Provides a mock NimBLE library implementation to simulate BLE functionality
 * for testing Nordic UART BLE code.
 */

#ifndef NIMBLEDEVICE_MOCK_H
#define NIMBLEDEVICE_MOCK_H

#include "Arduino.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Power levels
#define ESP_PWR_LVL_P9 9

// Connection handle constant
#define BLE_HS_CONN_HANDLE_NONE 0xFFFF

// Characteristic properties - using namespace to match real NimBLE API
namespace NIMBLE_PROPERTY {
constexpr uint32_t READ = 0x02;
constexpr uint32_t WRITE_NR = 0x04;
constexpr uint32_t WRITE = 0x08;
constexpr uint32_t NOTIFY = 0x10;
constexpr uint32_t INDICATE = 0x20;
}  // namespace NIMBLE_PROPERTY

// Max connections config
#define CONFIG_BT_NIMBLE_MAX_CONNECTIONS 3

// BLE gap connection descriptor
struct ble_gap_conn_desc {
    uint16_t conn_handle;
    uint8_t peer_ota_addr[6];
    uint8_t peer_id_addr[6];
    uint8_t our_id_addr[6];
    uint8_t our_ota_addr[6];
    uint8_t role;
    uint8_t encrypted;
    uint8_t authenticated;
    uint8_t bonded;
    uint8_t key_size;
};

// Forward declarations
class NimBLEServer;
class NimBLEService;
class NimBLECharacteristic;
class NimBLEAdvertising;
class NimBLEClient;
class NimBLERemoteService;
class NimBLERemoteCharacteristic;

// NimBLEUUID class
class NimBLEUUID {
  public:
    NimBLEUUID() : uuid_("") {}
    NimBLEUUID(const char* uuid) : uuid_(uuid ? uuid : "") {}
    NimBLEUUID(const std::string& uuid) : uuid_(uuid) {}

    std::string toString() const { return uuid_; }

    bool operator==(const NimBLEUUID& other) const { return uuid_ == other.uuid_; }
    bool operator!=(const NimBLEUUID& other) const { return uuid_ != other.uuid_; }

  private:
    std::string uuid_;
};

// NimBLEAddress class
class NimBLEAddress {
  public:
    NimBLEAddress() : addr_{0}, type_(0) {}
    NimBLEAddress(const uint8_t* addr) : type_(0) {
        if (addr)
            memcpy(addr_, addr, 6);
        else
            memset(addr_, 0, 6);
    }

    std::string toString() const {
        char buf[18];
        snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", addr_[5], addr_[4], addr_[3], addr_[2], addr_[1],
                 addr_[0]);
        return std::string(buf);
    }

    uint8_t getType() const { return type_; }

    bool operator==(const NimBLEAddress& other) const { return memcmp(addr_, other.addr_, 6) == 0; }

  private:
    uint8_t addr_[6];
    uint8_t type_;
};

// Callbacks interfaces
class NimBLEServerCallbacks {
  public:
    virtual ~NimBLEServerCallbacks() {}
    virtual void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) {}
    virtual void onDisconnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) {}
};

class NimBLECharacteristicCallbacks {
  public:
    virtual ~NimBLECharacteristicCallbacks() {}
    virtual void onWrite(NimBLECharacteristic* pCharacteristic) {}
    virtual void onRead(NimBLECharacteristic* pCharacteristic) {}
};

// NimBLECharacteristic
class NimBLECharacteristic {
  public:
    NimBLECharacteristic(const char* uuid, uint32_t properties)
        : uuid_(uuid ? uuid : ""), properties_(properties), callbacks_(nullptr) {}

    void setCallbacks(NimBLECharacteristicCallbacks* callbacks) { callbacks_ = callbacks; }

    void setValue(const uint8_t* data, size_t len) { value_.assign(data, data + len); }

    void setValue(const std::string& value) { value_.assign(value.begin(), value.end()); }

    std::string getValue() const { return std::string(value_.begin(), value_.end()); }

    void notify() { notifyCount_++; }

    // Test helpers
    const std::string& getUUID() const { return uuid_; }
    uint32_t getProperties() const { return properties_; }
    NimBLECharacteristicCallbacks* getCallbacks() const { return callbacks_; }
    int getNotifyCount() const { return notifyCount_; }
    void mockWrite(const std::string& data) {
        value_.assign(data.begin(), data.end());
        if (callbacks_)
            callbacks_->onWrite(this);
    }
    void mockWrite(const uint8_t* data, size_t len) {
        value_.assign(data, data + len);
        if (callbacks_)
            callbacks_->onWrite(this);
    }

  private:
    std::string uuid_;
    uint32_t properties_;
    NimBLECharacteristicCallbacks* callbacks_;
    std::vector<uint8_t> value_;
    int notifyCount_ = 0;
};

// NimBLEService
class NimBLEService {
  public:
    NimBLEService(const char* uuid) : uuid_(uuid ? uuid : "") {}

    NimBLECharacteristic* createCharacteristic(const char* uuid, uint32_t properties) {
        characteristics_.push_back(new NimBLECharacteristic(uuid, properties));
        return characteristics_.back();
    }

    void start() { started_ = true; }

    NimBLECharacteristic* getCharacteristic(const char* uuid) {
        for (auto* c : characteristics_) {
            if (c->getUUID() == uuid)
                return c;
        }
        return nullptr;
    }

    const std::string& getUUID() const { return uuid_; }
    bool isStarted() const { return started_; }

    ~NimBLEService() {
        for (auto* c : characteristics_)
            delete c;
    }

  private:
    std::string uuid_;
    std::vector<NimBLECharacteristic*> characteristics_;
    bool started_ = false;
};

// NimBLEAdvertising
class NimBLEAdvertising {
  public:
    void addServiceUUID(const char* uuid) { serviceUUIDs_.push_back(uuid ? uuid : ""); }

    void setScanResponse(bool enable) { scanResponse_ = enable; }

    void setMinPreferred(uint8_t minInterval) { minInterval_ = minInterval; }

    void setMaxPreferred(uint8_t maxInterval) { maxInterval_ = maxInterval; }

    bool start() {
        advertising_ = true;
        startCount_++;
        return true;
    }

    void stop() { advertising_ = false; }

    // Test helpers
    bool isAdvertising() const { return advertising_; }
    const std::vector<std::string>& getServiceUUIDs() const { return serviceUUIDs_; }
    int getStartCount() const { return startCount_; }
    void mockReset() {
        advertising_ = false;
        startCount_ = 0;
        serviceUUIDs_.clear();
    }

  private:
    bool advertising_ = false;
    bool scanResponse_ = false;
    uint8_t minInterval_ = 0;
    uint8_t maxInterval_ = 0;
    std::vector<std::string> serviceUUIDs_;
    int startCount_ = 0;
};

// NimBLEServer
class NimBLEServer {
  public:
    NimBLEServer() : callbacks_(nullptr), connectedCount_(0), started_(false) {}

    void setCallbacks(NimBLEServerCallbacks* callbacks) { callbacks_ = callbacks; }

    void start() { started_ = true; }

    NimBLEService* createService(const char* uuid) {
        services_.push_back(new NimBLEService(uuid));
        return services_.back();
    }

    NimBLEService* getServiceByUUID(const char* uuid) {
        for (auto* s : services_) {
            if (s->getUUID() == uuid)
                return s;
        }
        return nullptr;
    }

    int getConnectedCount() const { return connectedCount_; }

    void disconnect(uint16_t connHandle) {
        disconnectedHandle_ = connHandle;
        if (connectedCount_ > 0)
            connectedCount_--;
    }

    void updateConnParams(uint16_t connHandle, uint16_t minInterval, uint16_t maxInterval, uint16_t latency,
                          uint16_t timeout) {
        lastConnParamsHandle_ = connHandle;
        lastConnParamsTimeout_ = timeout;
    }

    // Test helpers
    NimBLEServerCallbacks* getCallbacks() const { return callbacks_; }
    uint16_t getDisconnectedHandle() const { return disconnectedHandle_; }
    uint16_t getLastConnParamsHandle() const { return lastConnParamsHandle_; }
    uint16_t getLastConnParamsTimeout() const { return lastConnParamsTimeout_; }

    void mockConnect(ble_gap_conn_desc* desc) {
        connectedCount_++;
        if (callbacks_)
            callbacks_->onConnect(this, desc);
    }

    void mockDisconnect(ble_gap_conn_desc* desc) {
        if (connectedCount_ > 0)
            connectedCount_--;
        if (callbacks_)
            callbacks_->onDisconnect(this, desc);
    }

    ~NimBLEServer() {
        for (auto* s : services_)
            delete s;
    }

  private:
    NimBLEServerCallbacks* callbacks_;
    std::vector<NimBLEService*> services_;
    int connectedCount_;
    bool started_;
    uint16_t disconnectedHandle_ = BLE_HS_CONN_HANDLE_NONE;
    uint16_t lastConnParamsHandle_ = BLE_HS_CONN_HANDLE_NONE;
    uint16_t lastConnParamsTimeout_ = 0;
};

// =============================================================================
// Client-side classes (for BLE client connections)
// =============================================================================

// Notify callback type
typedef void (*notify_callback)(NimBLERemoteCharacteristic* pBLERemoteCharacteristic, uint8_t* pData, size_t length,
                                bool isNotify);

// NimBLERemoteCharacteristic - represents a characteristic on a remote server
class NimBLERemoteCharacteristic {
  public:
    NimBLERemoteCharacteristic(const char* uuid) : uuid_(uuid ? uuid : ""), canNotify_(true) {}

    bool canNotify() const { return canNotify_; }

    bool subscribe(bool notifications, notify_callback callback) {
        subscribed_ = true;
        notifyCallback_ = callback;
        return mockSubscribeSuccess_;
    }

    bool writeValue(const uint8_t* data, size_t len, bool response = false) {
        (void)response;
        if (!mockWriteSuccess_)
            return false;
        value_.assign(data, data + len);
        writeCount_++;
        return true;
    }

    std::string getValue() const { return std::string(value_.begin(), value_.end()); }

    const std::string& getUUID() const { return uuid_; }

    // Test helpers
    void mockSetCanNotify(bool canNotify) { canNotify_ = canNotify; }
    void mockSetSubscribeSuccess(bool success) { mockSubscribeSuccess_ = success; }
    void mockSetWriteSuccess(bool success) { mockWriteSuccess_ = success; }
    void mockReceiveNotify(uint8_t* data, size_t len) {
        if (notifyCallback_)
            notifyCallback_(this, data, len, true);
    }
    int getWriteCount() const { return writeCount_; }
    bool isSubscribed() const { return subscribed_; }

  private:
    std::string uuid_;
    std::vector<uint8_t> value_;
    bool canNotify_;
    bool subscribed_ = false;
    notify_callback notifyCallback_ = nullptr;
    bool mockSubscribeSuccess_ = true;
    bool mockWriteSuccess_ = true;
    int writeCount_ = 0;
};

// NimBLERemoteService - represents a service on a remote server
class NimBLERemoteService {
  public:
    NimBLERemoteService(const char* uuid) : uuid_(uuid ? uuid : "") {}

    NimBLERemoteCharacteristic* getCharacteristic(const char* uuid) {
        for (auto* c : characteristics_) {
            if (c->getUUID() == uuid)
                return c;
        }
        return nullptr;
    }

    // Test helper to add characteristics
    void mockAddCharacteristic(NimBLERemoteCharacteristic* c) { characteristics_.push_back(c); }

    const std::string& getUUID() const { return uuid_; }

    ~NimBLERemoteService() {
        for (auto* c : characteristics_)
            delete c;
    }

  private:
    std::string uuid_;
    std::vector<NimBLERemoteCharacteristic*> characteristics_;
};

// NimBLEClientCallbacks - callback interface for client events
class NimBLEClientCallbacks {
  public:
    virtual ~NimBLEClientCallbacks() {}
    virtual void onConnect(NimBLEClient* pClient) {}
    virtual void onDisconnect(NimBLEClient* pClient) {}
};

// NimBLEClient - represents a connection to a remote BLE server
class NimBLEClient {
  public:
    NimBLEClient() : callbacks_(nullptr), connected_(false) {}

    void setClientCallbacks(NimBLEClientCallbacks* callbacks) { callbacks_ = callbacks; }

    void setConnectionParams(uint16_t minInterval, uint16_t maxInterval, uint16_t latency, uint16_t timeout) {
        minInterval_ = minInterval;
        maxInterval_ = maxInterval;
        latency_ = latency;
        timeout_ = timeout;
    }

    void setConnectTimeout(uint8_t timeout) { connectTimeout_ = timeout; }

    bool connect(const NimBLEAddress& address, bool deleteAttributes = true) {
        (void)deleteAttributes;
        connectAttempts_++;
        if (!mockConnectSuccess_)
            return false;
        connected_ = true;
        if (callbacks_)
            callbacks_->onConnect(this);
        return true;
    }

    void disconnect() {
        if (connected_) {
            connected_ = false;
            if (callbacks_)
                callbacks_->onDisconnect(this);
        }
    }

    bool isConnected() const { return connected_; }

    NimBLERemoteService* getService(const char* uuid) {
        for (auto* s : services_) {
            if (s->getUUID() == uuid)
                return s;
        }
        return nullptr;
    }

    NimBLERemoteService* getService(const NimBLEUUID& uuid) { return getService(uuid.toString().c_str()); }

    // Test helpers
    void mockSetConnectSuccess(bool success) { mockConnectSuccess_ = success; }
    void mockAddService(NimBLERemoteService* s) { services_.push_back(s); }
    void mockTriggerDisconnect() {
        connected_ = false;
        if (callbacks_)
            callbacks_->onDisconnect(this);
    }
    int getConnectAttempts() const { return connectAttempts_; }
    NimBLEClientCallbacks* getCallbacks() const { return callbacks_; }

    ~NimBLEClient() {
        for (auto* s : services_)
            delete s;
    }

  private:
    NimBLEClientCallbacks* callbacks_;
    bool connected_;
    bool mockConnectSuccess_ = true;
    int connectAttempts_ = 0;
    uint16_t minInterval_ = 0;
    uint16_t maxInterval_ = 0;
    uint16_t latency_ = 0;
    uint16_t timeout_ = 0;
    uint8_t connectTimeout_ = 0;
    std::vector<NimBLERemoteService*> services_;
};

// =============================================================================
// NimBLEDevice static class
// =============================================================================

// NimBLEDevice static class
class NimBLEDevice {
  public:
    static void init(const char* deviceName) {
        deviceName_ = deviceName ? deviceName : "";
        initialized_ = true;
    }

    static void deinit() {
        initialized_ = false;
        delete server_;
        server_ = nullptr;
    }

    static void setPower(int power) { power_ = power; }

    static NimBLEServer* createServer() {
        if (!server_)
            server_ = new NimBLEServer();
        return server_;
    }

    static NimBLEServer* getServer() { return server_; }

    static NimBLEAdvertising* getAdvertising() { return &advertising_; }

    static NimBLEClient* createClient() {
        NimBLEClient* client = new NimBLEClient();
        // Apply global mock settings to new clients
        client->mockSetConnectSuccess(mockNextConnectSuccess_);
        clients_.push_back(client);
        return client;
    }

    static bool getInitialized() { return initialized_; }

    // Set whether the next created client's connect() will succeed
    static void mockSetNextConnectSuccess(bool success) { mockNextConnectSuccess_ = success; }

    // Test helpers
    static const std::string& getDeviceName() { return deviceName_; }
    static bool isInitialized() { return initialized_; }
    static int getPower() { return power_; }
    static std::vector<NimBLEClient*>& getClients() { return clients_; }

    static void mockReset() {
        initialized_ = false;
        deviceName_ = "";
        power_ = 0;
        mockNextConnectSuccess_ = true;
        delete server_;
        server_ = nullptr;
        for (auto* c : clients_)
            delete c;
        clients_.clear();
        advertising_.mockReset();
    }

  private:
    static bool initialized_;
    static std::string deviceName_;
    static int power_;
    static bool mockNextConnectSuccess_;
    static NimBLEServer* server_;
    static NimBLEAdvertising advertising_;
    static std::vector<NimBLEClient*> clients_;
};

// Static member definitions
inline bool NimBLEDevice::initialized_ = false;
inline std::string NimBLEDevice::deviceName_ = "";
inline int NimBLEDevice::power_ = 0;
inline bool NimBLEDevice::mockNextConnectSuccess_ = true;
inline NimBLEServer* NimBLEDevice::server_ = nullptr;
inline NimBLEAdvertising NimBLEDevice::advertising_;
inline std::vector<NimBLEClient*> NimBLEDevice::clients_;

#endif  // NIMBLEDEVICE_MOCK_H
