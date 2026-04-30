package com.boardsesh.app.tabs;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.util.AttributeSet;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewPropertyAnimator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.DrawableRes;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.boardsesh.app.R;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Native bottom tab bar mirroring the iOS NativeTabBarView. Renders six tabs
 * (Home / Climb / Discover / Feed / Create / You) on a translucent dark
 * surface, with an active-tab tint, slide hide/show animation, and an
 * unread-notification badge on the You tab.
 */
public class NativeTabBarView extends FrameLayout {

    public static final int CONTENT_HEIGHT_DP = 49;

    // Colors mirror NativeTabBarView.swift constants.
    private static final int ACTIVE_COLOR = 0xFF8C4A52;
    private static final int INACTIVE_COLOR = 0xFF9CA3AF;
    private static final int BADGE_COLOR = 0xFFEF4444;
    private static final int BAR_BACKGROUND = 0xE60A0A0A;

    private static final long HIDE_ANIMATION_DURATION_MS = 300L;

    private static final TabDef[] TABS = new TabDef[]{
        new TabDef("home",    R.drawable.ic_tab_home,    "Home"),
        new TabDef("climbs",  R.drawable.ic_tab_climbs,  "Climb"),
        new TabDef("library", R.drawable.ic_tab_library, "Discover"),
        new TabDef("feed",    R.drawable.ic_tab_feed,    "Feed"),
        new TabDef("create",  R.drawable.ic_tab_create,  "Create"),
        new TabDef("you",     R.drawable.ic_tab_you,     "You"),
    };

    public interface OnTabTappedListener {
        void onTabTapped(@NonNull String tabKey);
    }

    private final Map<String, ImageView> tabIcons = new LinkedHashMap<>();
    private final Map<String, TextView> tabLabels = new LinkedHashMap<>();
    private TextView notificationBadge;
    private String activeTabKey = "home";
    @Nullable
    private OnTabTappedListener tabTappedListener;
    private boolean lastHiddenState = false;

    public NativeTabBarView(@NonNull Context context) {
        super(context);
        setupView();
    }

    public NativeTabBarView(@NonNull Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        setupView();
    }

    public NativeTabBarView(@NonNull Context context, @Nullable AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        setupView();
    }

    public void setOnTabTappedListener(@Nullable OnTabTappedListener listener) {
        this.tabTappedListener = listener;
    }

    public void setActiveTab(@NonNull String tabKey) {
        activeTabKey = tabKey;
        updateButtonAppearances();
    }

    /**
     * Slide the bar off-screen (down) when {@code hidden} is true. Idempotent:
     * repeat calls with the same value are no-ops, so rapid drawer
     * open/close events don't queue redundant animations.
     */
    public void setBarsHidden(boolean hidden) {
        setBarsHidden(hidden, true);
    }

    public void setBarsHidden(boolean hidden, boolean animated) {
        if (hidden == lastHiddenState) return;
        lastHiddenState = hidden;

        float targetTranslationY = hidden ? getHeight() : 0f;
        ViewPropertyAnimator animator = animate()
            .translationY(targetTranslationY)
            .setDuration(animated ? HIDE_ANIMATION_DURATION_MS : 0L);
        animator.start();
    }

    public void setNotificationBadge(int count) {
        if (notificationBadge == null) return;
        if (count <= 0) {
            notificationBadge.setVisibility(GONE);
            return;
        }
        notificationBadge.setVisibility(VISIBLE);
        notificationBadge.setText(count > 99 ? "99+" : String.valueOf(count));
    }

    private void setupView() {
        setBackgroundColor(BAR_BACKGROUND);

        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setWeightSum(TABS.length);
        FrameLayout.LayoutParams rowParams = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            dp(CONTENT_HEIGHT_DP)
        );
        rowParams.gravity = Gravity.TOP;
        addView(row, rowParams);

        for (TabDef tab : TABS) {
            row.addView(buildTabButton(tab));
        }

        updateButtonAppearances();
    }

    private View buildTabButton(@NonNull TabDef tab) {
        FrameLayout container = new FrameLayout(getContext());
        LinearLayout.LayoutParams containerParams = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.MATCH_PARENT,
            1f
        );
        container.setLayoutParams(containerParams);
        container.setClickable(true);
        container.setFocusable(true);
        container.setContentDescription(tab.label);
        container.setOnClickListener(v -> {
            if (tabTappedListener != null) {
                tabTappedListener.onTabTapped(tab.tabKey);
            }
        });

        LinearLayout column = new LinearLayout(getContext());
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams columnParams = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.MATCH_PARENT
        );
        container.addView(column, columnParams);

        ImageView icon = new ImageView(getContext());
        icon.setImageResource(tab.iconRes);
        icon.setColorFilter(INACTIVE_COLOR, PorterDuff.Mode.SRC_IN);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(
            dp(22),
            dp(22)
        );
        column.addView(icon, iconParams);

        TextView label = new TextView(getContext());
        label.setText(tab.label);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f);
        label.setTextColor(INACTIVE_COLOR);
        label.setIncludeFontPadding(false);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        labelParams.topMargin = dp(2);
        column.addView(label, labelParams);

        tabIcons.put(tab.tabKey, icon);
        tabLabels.put(tab.tabKey, label);

        if ("you".equals(tab.tabKey)) {
            notificationBadge = buildNotificationBadge();
            container.addView(notificationBadge);
        }

        return container;
    }

    private TextView buildNotificationBadge() {
        TextView badge = new TextView(getContext());
        badge.setBackground(buildBadgeBackground());
        badge.setTextColor(Color.WHITE);
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9f);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(4), 0, dp(4), 0);
        badge.setIncludeFontPadding(false);
        badge.setVisibility(GONE);

        FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            dp(14)
        );
        badgeParams.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        badgeParams.topMargin = dp(4);
        badgeParams.leftMargin = dp(8);
        badge.setLayoutParams(badgeParams);
        badge.setMinWidth(dp(14));
        return badge;
    }

    private android.graphics.drawable.GradientDrawable buildBadgeBackground() {
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        bg.setColor(BADGE_COLOR);
        bg.setCornerRadius(dp(7));
        return bg;
    }

    private void updateButtonAppearances() {
        for (TabDef tab : TABS) {
            boolean isActive = tab.tabKey.equals(activeTabKey);
            int color = isActive ? ACTIVE_COLOR : INACTIVE_COLOR;
            ImageView icon = tabIcons.get(tab.tabKey);
            TextView label = tabLabels.get(tab.tabKey);
            if (icon != null) icon.setColorFilter(color, PorterDuff.Mode.SRC_IN);
            if (label != null) label.setTextColor(color);
        }
    }

    private int dp(int dp) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            dp,
            getResources().getDisplayMetrics()
        );
    }

    private static final class TabDef {
        final String tabKey;
        @DrawableRes
        final int iconRes;
        final String label;

        TabDef(String tabKey, @DrawableRes int iconRes, String label) {
            this.tabKey = tabKey;
            this.iconRes = iconRes;
            this.label = label;
        }
    }
}
