#import <Capacitor/Capacitor.h>

CAP_PLUGIN(NativeWebSocketPlugin, "NativeWebSocket",
    CAP_PLUGIN_METHOD(connect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(disconnect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(sendOperation, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(subscribe, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(unsubscribe, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(updateAuthToken, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(setWebviewActive, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(flushBuffer, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getConnectionState, CAPPluginReturnPromise);
)
