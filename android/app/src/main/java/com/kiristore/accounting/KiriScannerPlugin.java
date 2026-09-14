package com.kiristore.accounting;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.UUID;

/**
 * The phone's own document scanner and share sheet, for the Android wrapper
 * around the same web app. Both are unreachable from a browser: the web app
 * keeps its in-app camera and its downloads wherever this plugin is absent.
 *
 * Pages come back as JPEG at the app's own size (2500px, quality 88), so the
 * web side stores exactly what it would have produced itself. Shared files go
 * the other way in chunks: a 36MB export must never sit in memory twice.
 */
@CapacitorPlugin(name = "KiriScanner")
public class KiriScannerPlugin extends Plugin {

    private static final int MAX_EDGE = 2500;
    private static final int JPEG_QUALITY = 88;
    private static final String SHARE_DIR = "shared-exports";
    /** Hosts the WebView must load itself: the app, and the sign-in check it opens in an iframe. */
    private static final String[] INTERNAL_HOSTS = {
        "kiri-store-accounting.web.app",
        "kiri-store-accounting.firebaseapp.com",
        "www.google.com",
        "www.gstatic.com",
        "www.recaptcha.net",
        "recaptcha.net",
        "apis.google.com",
        "identitytoolkit.googleapis.com",
        "securetoken.googleapis.com",
    };

    private ActivityResultLauncher<IntentSenderRequest> scanLauncher;
    private String pendingScanId;
    private final Map<String, File> shares = new ConcurrentHashMap<>();

    @Override
    public void load() {
        scanLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onScanResult
        );
        deleteRecursively(new File(getContext().getCacheDir(), SHARE_DIR));
    }

    /** Google Play services carries the scanner; without it the app stays on its own camera. */
    @PluginMethod
    public void available(PluginCall call) {
        int status = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext());
        JSObject result = new JSObject();
        result.put("available", status == ConnectionResult.SUCCESS);
        call.resolve(result);
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (pendingScanId != null) {
            call.reject("הסורק כבר פתוח.");
            return;
        }
        int limit = Math.max(1, Math.min(8, call.getInt("limit", 8)));
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(limit)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        bridge.saveCall(call);
        pendingScanId = call.getCallbackId();
        getActivity()
            .runOnUiThread(() ->
                GmsDocumentScanning.getClient(options)
                    .getStartScanIntent(getActivity())
                    .addOnSuccessListener(sender -> {
                        try {
                            scanLauncher.launch(new IntentSenderRequest.Builder(sender).build());
                        } catch (Exception error) {
                            failScan("לא ניתן לפתוח את הסורק של הטלפון.");
                        }
                    })
                    .addOnFailureListener(error -> failScan("הסורק של הטלפון לא נפתח. אפשר לצלם דרך ״מצלמת הטלפון״."))
            );
    }

    private void onScanResult(ActivityResult activityResult) {
        PluginCall call = takePendingScan();
        if (call == null) return;
        Intent data = activityResult.getData();
        GmsDocumentScanningResult result = data == null ? null : GmsDocumentScanningResult.fromActivityResultIntent(data);
        if (result == null || result.getPages() == null) {
            // Cancelled with the back gesture or without keeping a page.
            call.resolve(pagesResult(new JSArray()));
            return;
        }
        List<Uri> uris = new ArrayList<>();
        for (GmsDocumentScanningResult.Page page : result.getPages()) uris.add(page.getImageUri());
        bridge.execute(() -> {
            JSArray pages = new JSArray();
            try {
                int index = 1;
                for (Uri uri : uris) pages.put(encodePage(uri, index++));
            } catch (Exception error) {
                call.reject("לא ניתן להכין את העמודים שנסרקו. נסה שוב.");
                return;
            }
            call.resolve(pagesResult(pages));
        });
    }

    private JSObject pagesResult(JSArray pages) {
        JSObject result = new JSObject();
        result.put("pages", pages);
        return result;
    }

    private void failScan(String message) {
        PluginCall call = takePendingScan();
        if (call != null) call.reject(message);
    }

    private PluginCall takePendingScan() {
        if (pendingScanId == null) return null;
        PluginCall call = bridge.getSavedCall(pendingScanId);
        bridge.releaseCall(pendingScanId);
        pendingScanId = null;
        return call;
    }

    /** Decode without ever holding the full sensor image: bounds first, then a sampled decode. */
    private JSObject encodePage(Uri uri, int index) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(stream, null, bounds);
        }
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        if (longest <= 0) throw new IllegalStateException("page has no pixels");
        BitmapFactory.Options decode = new BitmapFactory.Options();
        decode.inSampleSize = 1;
        while (longest / (decode.inSampleSize * 2) >= MAX_EDGE) decode.inSampleSize *= 2;
        Bitmap bitmap;
        try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) {
            bitmap = BitmapFactory.decodeStream(stream, null, decode);
        }
        if (bitmap == null) throw new IllegalStateException("page could not be decoded");
        try {
            int width = bitmap.getWidth(), height = bitmap.getHeight();
            int edge = Math.max(width, height);
            if (edge > MAX_EDGE) {
                float scale = (float) MAX_EDGE / edge;
                Bitmap scaled = Bitmap.createScaledBitmap(
                    bitmap,
                    Math.max(1, Math.round(width * scale)),
                    Math.max(1, Math.round(height * scale)),
                    true
                );
                if (scaled != bitmap) {
                    bitmap.recycle();
                    bitmap = scaled;
                }
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
            JSObject page = new JSObject();
            page.put("name", "scan-" + index + ".jpg");
            page.put("mime", "image/jpeg");
            page.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            return page;
        } finally {
            bitmap.recycle();
        }
    }

    @PluginMethod
    public void shareFileStart(PluginCall call) {
        String name = call.getString("name", "file");
        try {
            File dir = new File(getContext().getCacheDir(), SHARE_DIR);
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cache directory unavailable");
            String id = UUID.randomUUID().toString();
            File file = new File(dir, id + "-" + safeName(name));
            if (!file.createNewFile()) throw new IllegalStateException("file already exists");
            shares.put(id, file);
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("לא ניתן להכין את הקובץ לשיתוף.");
        }
    }

    @PluginMethod
    public void shareFileChunk(PluginCall call) {
        File file = shares.get(call.getString("id", ""));
        String data = call.getString("data", "");
        if (file == null) {
            call.reject("הקובץ לשיתוף אינו זמין יותר. נסה שוב.");
            return;
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception error) {
            call.reject("לא ניתן לכתוב את הקובץ לשיתוף.");
        }
    }

    @PluginMethod
    public void shareFiles(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        ArrayList<Uri> uris = new ArrayList<>();
        String mime = call.getString("mime", "*/*");
        try {
            for (Object id : ids.toList()) {
                File file = shares.remove(String.valueOf(id));
                if (file == null || !file.exists()) throw new IllegalStateException("missing share file");
                uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file));
            }
        } catch (Exception error) {
            call.reject("הקבצים לשיתוף אינם זמינים. נסה שוב.");
            return;
        }
        if (uris.isEmpty()) {
            call.reject("אין קבצים לשיתוף.");
            return;
        }
        Intent intent;
        if (uris.size() == 1) {
            intent = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else {
            intent = new Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        }
        intent.setType(mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(intent, "שליחת הקבצים");
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> getActivity().startActivity(chooser));
        call.resolve();
    }

    /**
     * Capacitor sends every navigation whose host it does not know to the
     * phone's browser, iframes included. The sign-in check runs in one, so the
     * hosts the app itself depends on stay inside the WebView.
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String host = url.getHost();
        if (host == null) return null;
        for (String internal : INTERNAL_HOSTS) if (host.equalsIgnoreCase(internal)) return false;
        return null;
    }

    private static String safeName(String name) {
        String cleaned = name.replaceAll("[^A-Za-z0-9._-]", "_");
        return cleaned.isEmpty() ? "file" : cleaned.substring(0, Math.min(cleaned.length(), 60));
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }
}
