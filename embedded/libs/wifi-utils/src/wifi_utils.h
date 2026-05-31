#ifndef WIFI_UTILS_H
#define WIFI_UTILS_H

#include <Arduino.h>
#include <WiFi.h>
#include <DNSServer.h>

#include <config_manager.h>

#define WIFI_CONNECT_TIMEOUT_MS 30000
#define WIFI_RECONNECT_INTERVAL_MS 5000
#define DEFAULT_AP_NAME "Boardsesh-Setup"
#define DEFAULT_AP_IP "192.168.4.1"
#define DNS_PORT 53

enum class WiFiConnectionState { DISCONNECTED, CONNECTING, CONNECTED, CONNECTION_FAILED, AP_MODE };

typedef void (*WiFiStateCallback)(WiFiConnectionState state);

class WiFiUtils {
  public:
    WiFiUtils();

    void begin();
    void loop();

    bool connect(const char* ssid, const char* password, bool save = true);
    bool connectSaved();
    void disconnect();

    // Access Point mode
    bool startAP(const char* apName = DEFAULT_AP_NAME);
    void stopAP();
    bool isAPMode();
    String getAPIP();
    bool hasSavedCredentials();

    bool isConnected();
    WiFiConnectionState getState();

    String getSSID();
    String getIP();
    int8_t getRSSI();

    void configureMdns(const char* deviceName, const char* serviceType, uint16_t servicePort, const char* role);
    void setMdnsDeviceName(const char* deviceName);
    void restartMdns();
    void stopMdns();
    String getMdnsHostName();

    void setStateCallback(WiFiStateCallback callback);

    static String buildMdnsHostName(const String& deviceName, const String& macAddress);

    // Config keys
    static const char* KEY_SSID;
    static const char* KEY_PASSWORD;

  private:
    WiFiConnectionState state;
    WiFiStateCallback stateCallback;
    unsigned long connectStartTime;
    unsigned long lastReconnectAttempt;
    String currentSSID;
    String currentPassword;
    String mdnsDeviceName;
    String mdnsHostName;
    String mdnsServiceType;
    String mdnsRole;
    uint16_t mdnsServicePort;
    bool mdnsRunning;

    DNSServer dnsServer;
    bool dnsRunning;

    void setState(WiFiConnectionState newState);
    void checkConnection();
    void startMdns();
};

extern WiFiUtils WiFiMgr;

#endif
