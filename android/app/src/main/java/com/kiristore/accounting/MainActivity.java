package com.kiristore.accounting;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KiriScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
