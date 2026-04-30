package com.boardsesh.app.plugins;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.boardsesh.app.MainActivity;
import com.boardsesh.app.tabs.TabContainerController;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridges JavaScript to the native tab bar held by {@link MainActivity}'s
 * {@link TabContainerController}. Mirrors {@code NativeTabBarPlugin.swift}:
 * exposes {@code setActiveTab}, {@code setBarsHidden},
 * {@code setNotificationBadge}, and {@code navigateTab} on
 * {@code window.Capacitor.Plugins.NativeTabBar}.
 */
@CapacitorPlugin(name = "NativeTabBar")
public class NativeTabBarPlugin extends Plugin {

    private static final String TAG = "NativeTabBarPlugin";

    @PluginMethod
    public void setActiveTab(PluginCall call) {
        String tab = call.getString("tab", "home");
        runOnUi(() -> {
            TabContainerController controller = controller();
            if (controller != null && controller.getTabBarView() != null) {
                controller.getTabBarView().setActiveTab(tab);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setBarsHidden(PluginCall call) {
        boolean hidden = Boolean.TRUE.equals(call.getBoolean("hidden", false));
        runOnUi(() -> {
            TabContainerController controller = controller();
            if (controller != null && controller.getTabBarView() != null) {
                controller.getTabBarView().setBarsHidden(hidden);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setNotificationBadge(PluginCall call) {
        Integer count = call.getInt("count", 0);
        int safeCount = count == null ? 0 : count;
        runOnUi(() -> {
            TabContainerController controller = controller();
            if (controller != null && controller.getTabBarView() != null) {
                controller.getTabBarView().setNotificationBadge(safeCount);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void navigateTab(PluginCall call) {
        String tab = call.getString("tab", "home");
        String url = call.getString("url", "/");
        runOnUi(() -> {
            TabContainerController controller = controller();
            if (controller == null) {
                call.reject("TabContainerController not available");
                return;
            }
            controller.navigateToTab(tab, url);
            call.resolve();
        });
    }

    private TabContainerController controller() {
        Activity activity = getActivity();
        if (activity instanceof MainActivity) {
            return ((MainActivity) activity).getTabContainerController();
        }
        Log.w(TAG, "Host activity is not MainActivity; no controller available");
        return null;
    }

    private void runOnUi(Runnable runnable) {
        new Handler(Looper.getMainLooper()).post(runnable);
    }
}
