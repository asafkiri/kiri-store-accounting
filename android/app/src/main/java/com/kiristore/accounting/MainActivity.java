package com.kiristore.accounting;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KiriScannerPlugin.class);
        super.onCreate(savedInstanceState);
        keepClearOfSystemBars();
    }

    /**
     * Recent Android draws every app edge to edge: the page runs under the
     * clock at the top and under the phone's own back/home/recents buttons at
     * the bottom. The page asks for those measurements itself — the viewport is
     * declared with viewport-fit=cover and the stylesheet reads
     * env(safe-area-inset-*) — but a WebView is never told them, so they arrive
     * as zero and the app's own bottom bar lands on top of the phone's buttons.
     *
     * The page is inset instead, by the bars the system actually reports on this
     * phone: a Galaxy with three buttons gives back a tall strip, a phone driven
     * by gestures a thin one, and a device that insets its WebView already
     * reports nothing and nothing moves. The strips left behind are painted the
     * same white as the bar above them, so the seam does not read as a gap.
     */
    private void keepClearOfSystemBars() {
        View content = findViewById(android.R.id.content);
        if (content == null) return;
        content.setBackgroundColor(Color.WHITE);
        // The strips are white, so the clock, the battery and the phone's own
        // buttons have to be drawn dark to stay readable on them.
        WindowInsetsControllerCompat appearance = WindowCompat.getInsetsController(getWindow(), content);
        appearance.setAppearanceLightStatusBars(true);
        appearance.setAppearanceLightNavigationBars(true);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            // The keyboard is deliberately not included: it is already handled by
            // the window resizing, and padding for it too would double the gap.
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
