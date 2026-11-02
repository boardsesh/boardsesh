#pragma once
#include "gym/cache.h"
#include "nimble/nimble/host/src/ble_hs_hci_priv.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_bt.h>

#include <atomic>

// Hardware feasibility mode: production identities are never created until
// independent connectable advertisements and local-address routing are proven.
namespace {
constexpr const char* NUS_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* RX_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* AURORA_UUID = "4488B571-7806-4DF6-BCFF-A2897E4953FF";
constexpr const char* NAMES[] = {"Kilter Board#99000001@3", "Tension Board#99000002@3", "MoonBoard A#99000003"};
constexpr const char* ADDRESSES[] = {"C6:CB:8F:D7:56:91", "C6:CB:8F:D7:56:92", "C6:CB:8F:D7:56:93"};
struct Connection {
    uint16_t handle = BLE_HS_CONN_HANDLE_NONE;
    int board = -1;
};
Connection connections[3];
std::atomic<unsigned> writes[3];
std::atomic<unsigned> connectedCount{0};
NimBLECharacteristic* tx = nullptr;
NimBLEExtAdvertising* advertising = nullptr;
bool ready = false;
bool configuredSteps[3][3] = {};
int supportedSets = -1;
int supportedSetsRc = -1;
int startErrors[3] = {};

int boardForConnection(uint16_t handle) {
    for (const auto& connection : connections) {
        if (connection.handle == handle)
            return connection.board;
    }
    return -1;
}

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* server, NimBLEConnInfo& connection) override {
        ble_gap_conn_desc descriptor{};
        int board = -1;
        if (ble_gap_conn_find(connection.getConnHandle(), &descriptor) == 0) {
            const NimBLEAddress localAddress(descriptor.our_ota_addr);
            for (int index = 0; index < 3; ++index) {
                if (localAddress == NimBLEAddress(ADDRESSES[index], BLE_ADDR_RANDOM))
                    board = index;
            }
            Serial.printf("FIXTURE_CONNECT handle=%u local=%s board=%d\n", connection.getConnHandle(),
                          localAddress.toString().c_str(), board);
        }
        if (board < 0) {
            server->disconnect(connection.getConnHandle());
            return;
        }
        for (auto& slot : connections) {
            if (slot.handle == BLE_HS_CONN_HANDLE_NONE) {
                slot.handle = connection.getConnHandle();
                slot.board = board;
                connectedCount.fetch_add(1);
                return;
            }
        }
        server->disconnect(connection.getConnHandle());
    }

    void onDisconnect(NimBLEServer*, NimBLEConnInfo& connection, int reason) override {
        for (auto& slot : connections) {
            if (slot.handle == connection.getConnHandle()) {
                Serial.printf("FIXTURE_DISCONNECT handle=%u board=%d reason=%d\n", slot.handle, slot.board, reason);
                slot.handle = BLE_HS_CONN_HANDLE_NONE;
                slot.board = -1;
                connectedCount.fetch_sub(1);
            }
        }
    }
} serverCallbacks;

class ReceiveCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connection) override {
        const int board = boardForConnection(connection.getConnHandle());
        if (board < 0)
            return;
        const auto payload = characteristic->getValue();
        writes[board].fetch_add(1);
        Serial.printf("FIXTURE_WRITE handle=%u board=%d bytes=%u\n", connection.getConnHandle(), board,
                      static_cast<unsigned>(payload.size()));
        std::string reply = std::to_string(board) + ":";
        reply.append(reinterpret_cast<const char*>(payload.data()), payload.size());
        tx->notify(reinterpret_cast<const uint8_t*>(reply.data()), reply.size(), connection.getConnHandle());
    }
} receiveCallbacks;

void printStatus() {
    Serial.printf("{\"mode\":\"ble-feasibility\",\"ready\":%s,\"supportedSets\":%d,\"supportedSetsRc\":%d,"
                  "\"connections\":%u,\"boards\":[",
                  ready ? "true" : "false", supportedSets, supportedSetsRc, connectedCount.load());
    for (int board = 0; board < 3; ++board) {
        Serial.printf("%s{\"name\":\"%s\",\"address\":\"%s\",\"advertising\":%s,\"writes\":%u,\"steps\":[%d,%d,%d],"
                      "\"startError\":%d}",
                      board ? "," : "", NAMES[board], ADDRESSES[board],
                      advertising && advertising->isActive(board) ? "true" : "false", writes[board].load(),
                      configuredSteps[board][0], configuredSteps[board][1], configuredSteps[board][2],
                      startErrors[board]);
    }
    Serial.println("]}");
}
}  // namespace

void setup() {
    Serial.begin(115200);
    delay(1000);
    NimBLEDevice::init("Boardsesh gym fixture");
    NimBLEDevice::setMTU(247);
    ble_hci_le_rd_num_of_adv_sets_rp supported{};
    supportedSetsRc = ble_hs_hci_cmd_tx(BLE_HCI_OP(BLE_HCI_OGF_LE, BLE_HCI_OCF_LE_RD_NUM_OF_ADV_SETS), nullptr, 0,
                                        &supported, sizeof(supported));
    if (supportedSetsRc == 0)
        supportedSets = supported.num_sets;
    NimBLEServer* server = NimBLEDevice::createServer();
    server->setCallbacks(&serverCallbacks, false);
    NimBLEService* service = server->createService(NUS_UUID);
    tx = service->createCharacteristic(TX_UUID, NIMBLE_PROPERTY::NOTIFY);
    auto* rx = service->createCharacteristic(RX_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    rx->setCallbacks(&receiveCallbacks);
    service->start();
    server->start();
    advertising = NimBLEDevice::getAdvertising();
    ready = true;
    for (int board = 0; board < 3; ++board) {
        NimBLEExtAdvertisement advertisement;
        advertisement.setLegacyAdvertising(true);
        advertisement.setConnectable(true);
        advertisement.setScannable(true);
        advertisement.setAddress(NimBLEAddress(ADDRESSES[board], BLE_ADDR_RANDOM));
        advertisement.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
        advertisement.addServiceUUID(board == 2 ? NUS_UUID : AURORA_UUID);
        NimBLEExtAdvertisement scanResponse;
        scanResponse.setName(NAMES[board]);
        configuredSteps[board][0] = advertising->setInstanceData(board, advertisement);
        configuredSteps[board][1] = configuredSteps[board][0] && advertising->setScanResponseData(board, scanResponse);
        configuredSteps[board][2] = configuredSteps[board][1] && advertising->start(board);
        if (configuredSteps[board][1] && !configuredSteps[board][2])
            startErrors[board] = ble_gap_ext_adv_start(board, 0, 0);
        const bool configured = configuredSteps[board][2];
        ready = ready && configured;
        Serial.printf("FIXTURE_ADV board=%d configured=%d name=%s\n", board, configured, NAMES[board]);
    }
    printStatus();
}

void loop() {
    static String command;
    while (Serial.available()) {
        const char character = Serial.read();
        if (character == '\n' || character == '\r') {
            if (command == "fixture-status")
                printStatus();
            command = "";
        } else if (command.length() < 64) {
            command += character;
        }
    }
    static unsigned long lastEnsureAt = 0;
    if (ready && millis() - lastEnsureAt >= 1000) {
        lastEnsureAt = millis();
        for (int board = 0; board < 3; ++board) {
            if (!advertising->isActive(board))
                advertising->start(board);
        }
    }
    delay(5);
}
