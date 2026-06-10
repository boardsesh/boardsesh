#ifndef ESP_WEB_SERVER_H
#define ESP_WEB_SERVER_H

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <wifi_utils.h>

#include <Update.h>

#include <config_manager.h>

#define WEB_SERVER_PORT 80

typedef void (*WebServerRouteHandler)(WebServer& server);
typedef void (*WebServerStatusProvider)(JsonDocument& doc);

class ESPWebServer {
  public:
    ESPWebServer();

    void begin();
    void loop();
    void stop();

    // Add custom route handlers
    void on(const char* path, HTTPMethod method, WebServerRouteHandler handler);
    void setStatusProvider(WebServerStatusProvider provider);

    // Send JSON response
    void sendJson(int code, JsonDocument& doc);
    void sendJson(int code, const char* json);

    // Send error response
    void sendError(int code, const char* message);

    // Get underlying server for advanced use
    WebServer& getServer();

  private:
    WebServer server;
    bool running;
    WebServerStatusProvider statusProvider;

    // Built-in handlers
    void handleRoot();
    void handleNotFound();
    void handleCaptivePortal();
    void handleGetConfig();
    void handleSetConfig();
    void handleGetStatus();
    void handleWiFiScan();
    void handleWiFiConnect();
    void handleWiFiStatus();
    void handleRestart();

    // OTA firmware update handlers
    void handleFirmwareVersion();
    void handleFirmwareUploadComplete();
    void handleFirmwareUploadData();

    // OTA state
    bool _otaInProgress = false;
    size_t _otaBytesWritten = 0;
    bool _otaError = false;
    String _otaErrorMessage;

    void setupRoutes();
    void setCorsHeaders();
};

extern ESPWebServer WebConfig;

#endif
