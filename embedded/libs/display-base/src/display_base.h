// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef DISPLAY_BASE_H
#define DISPLAY_BASE_H

#include <Arduino.h>
#include <vector>

#include "display_types.h"

// ============================================
// Abstract Display Base Class
// ============================================
// Manages all shared state (climb, queue, navigation, status)
// and delegates rendering to subclass-specific draw methods.

class DisplayBase {
  public:
    DisplayBase();
    virtual ~DisplayBase();

    // ====== Hardware init (implemented by each display) ======
    virtual bool begin() = 0;

    // ====== Status indicators (implemented in base, calls onStatusChanged) ======
    void setWiFiStatus(bool connected);
    void setBackendStatus(bool connected);
    void setBleStatus(bool enabled, bool connected);

    // ====== Full screen modes (implemented by each display) ======
    virtual void showConnecting() = 0;
    virtual void showError(const char* message, const char* ipAddress = nullptr) = 0;
    virtual void showConfigPortal(const char* apName, const char* ip) = 0;
    virtual void showSetupScreen(const char* apName) = 0;

    // ====== Climb display (implemented in base, calls refresh) ======
    void showClimb(const char* name, const char* grade, const char* gradeColor, int angle, const char* uuid,
                   const char* boardType);
    void showNoClimb();

    // ====== Session ID for QR code ======
    void setSessionId(const char* sessionId);

    // ====== History management ======
    void addToHistory(const char* name, const char* grade, const char* gradeColor);
    void clearHistory();

    // ====== Queue navigation (for prev/next indicators) ======
    void setNavigationContext(const QueueNavigationItem& prevClimb, const QueueNavigationItem& nextClimb,
                              int currentIndex, int totalCount);
    void clearNavigationContext();

    // ====== Local queue management ======
    void setQueueFromSync(LocalQueueItem* items, int count, int currentIndex);
    void clearQueue();
    int getQueueCount() const { return _queueCount; }
    int getCurrentQueueIndex() const { return _currentQueueIndex; }
    const LocalQueueItem* getQueueItem(int index) const;
    const LocalQueueItem* getCurrentQueueItem() const;
    const LocalQueueItem* getPreviousQueueItem() const;
    const LocalQueueItem* getNextQueueItem() const;
    bool canNavigatePrevious() const { return _queueCount > 0 && _currentQueueIndex > 0; }
    bool canNavigateNext() const { return _queueCount > 0 && _currentQueueIndex < _queueCount - 1; }
    bool canNavigateToIndex(int index) const { return _queueCount > 0 && index >= 0 && index < _queueCount; }

    // ====== Optimistic navigation (returns true if navigation was possible) ======
    bool navigateToPrevious();
    bool navigateToNext();
    bool navigateToIndex(int index);
    void setCurrentQueueIndex(int index);

    // ====== Pending navigation state (for reconciliation with backend) ======
    bool hasPendingNavigation() const { return _pendingNavigation; }
    void clearPendingNavigation() { _pendingNavigation = false; }
    const char* getPendingQueueItemUuid() const;
    void setPendingNavigation(bool pending) { _pendingNavigation = pending; }

    // ====== Climb display (info-only, skips board image redraw) ======
    void showClimbInfoOnly(const char* name, const char* grade, const char* gradeColor, int angle, const char* uuid,
                           const char* boardType);

    // ====== Refresh all sections (implemented by each display) ======
    virtual void refresh() = 0;

    // ====== Refresh info sections only (status, climb info, nav) - skips board image ======
    virtual void refreshInfoOnly() { refresh(); }

    // ====== Utility ======
    static uint16_t hexToRgb565(const char* hex);

  protected:
    // Called when WiFi/BLE/backend status changes (each display redraws its status bar)
    virtual void onStatusChanged() = 0;

    // QR code URL management
    void setQRCodeUrl(const char* url);

    // ====== Status state ======
    bool _wifiConnected;
    bool _backendConnected;
    bool _bleEnabled;
    bool _bleConnected;

    // ====== Current climb state ======
    bool _hasClimb;
    String _climbName;
    String _grade;
    String _gradeColor;
    int _angle;
    String _climbUuid;
    String _boardType;

    // ====== Session ID for QR code URL ======
    String _sessionId;

    // ====== History ======
    std::vector<ClimbHistoryEntry> _history;
    static const int MAX_HISTORY_ITEMS = 5;

    // ====== Local queue storage ======
    LocalQueueItem _queueItems[MAX_QUEUE_SIZE];
    int _queueCount;
    int _currentQueueIndex;
    bool _pendingNavigation;

    // ====== Navigation state (from backend) ======
    QueueNavigationItem _prevClimb;
    QueueNavigationItem _nextClimb;
    int _queueIndex;
    int _queueTotal;
    bool _hasNavigation;

    // ====== QR code data ======
    // QR Version 6: size = 6*4+17 = 41 modules per side
    // Buffer = ((41*41)+7)/8 = 211 bytes
    static const int QR_VERSION = 6;
    static const int QR_BUFFER_SIZE = 211;
    uint8_t _qrCodeData[QR_BUFFER_SIZE];
    String _qrUrl;
    bool _hasQRCode;
};

#endif  // DISPLAY_BASE_H
