package dev.nimbus.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

/** Nimbus in a WebView, with microphone (dictation), file uploads, and approval/reply notifications. */
public class MainActivity extends Activity {
    private static final int REQ_MIC = 1, REQ_FILES = 2, REQ_NOTIFY = 3;
    static boolean visible = false;

    private WebView web;
    private PermissionRequest pendingMic;
    private ValueCallback<Uri[]> pendingFiles;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#11131a"));
        // Android 15 draws apps edge to edge (under the status bar, nav bar and keyboard) and ignores
        // adjustResize. A WebView ignores its own padding, so pad a container around it instead.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#11131a"));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets b = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime() | android.view.WindowInsets.Type.displayCutout());
                v.setPadding(b.left, b.top, b.right, b.bottom);
                return android.view.WindowInsets.CONSUMED;
            });
        } else root.setFitsSystemWindows(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // Lay out like a phone browser: honour the page's viewport tag, and don't let the phone's font-size
        // setting scale the page on top of it (that breaks the layout; pinch zoom still works).
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " NimbusApp/2");
        web.addJavascriptInterface(new Bridge(), "NimbusApp");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError err) { handleSsl(h, err); }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                // Our own server stays in the app; other links open in the phone's browser.
                Uri u = r.getUrl(), base = Uri.parse(Trust.serverUrl(MainActivity.this));
                String host = u.getHost() == null ? "" : u.getHost();
                if (host.equals(base.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                CookieManager.getInstance().flush();
                if (CookieManager.getInstance().getCookie(Trust.serverUrl(MainActivity.this)) != null) startEvents();
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) askForUrl("Couldn’t reach Nimbus (" + e.getDescription() + "). Check the address:");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest req) {
                // Only the Nimbus page asks for the mic (dictation). Grant it once Android allows recording.
                boolean ours = req.getOrigin() != null && req.getOrigin().getHost() != null
                        && req.getOrigin().getHost().equals(Uri.parse(Trust.serverUrl(MainActivity.this)).getHost());
                if (!ours) { req.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingMic = req;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(i, "Attach files"), REQ_FILES); }
                catch (Exception e) { pendingFiles = null; return false; }
                return true;
            }
        });

        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);

        if (Trust.serverUrl(this) == null) askForUrl("Your Nimbus address:");
        else load(getIntent());
    }

    private void load(Intent intent) {
        String url = Trust.serverUrl(this);
        String thread = intent == null ? null : intent.getStringExtra("thread");
        web.loadUrl(url + "/" + (thread != null ? "#" + thread : ""));
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String thread = intent.getStringExtra("thread");
        if (thread != null) web.evaluateJavascript("location.hash = " + org.json.JSONObject.quote(thread), null);
    }

    private void askForUrl(String message) {
        final EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        String cur = Trust.serverUrl(this);
        in.setText(cur != null ? cur : Trust.DEFAULT_URL);
        new AlertDialog.Builder(this).setTitle("Nimbus").setMessage(message).setView(in).setCancelable(false)
                .setPositiveButton("Connect", (d, w) -> {
                    String u = in.getText().toString().trim();
                    if (!u.startsWith("http")) u = "https://" + u;
                    Trust.setServerUrl(this, u);
                    load(null);
                }).show();
    }

    private void handleSsl(SslErrorHandler h, SslError err) {
        String host = Uri.parse(err.getUrl()).getHost();
        String fp = err.getCertificate().getX509Certificate() != null ? Trust.fingerprint(err.getCertificate().getX509Certificate()) : "";
        String pin = Trust.pinned(this, host);
        if (!fp.isEmpty() && fp.equals(pin)) { h.proceed(); return; }
        String msg = (pin == null
                ? "This Nimbus server uses its own certificate. Trust it on this phone?"
                : "WARNING: the certificate changed since you last connected. Only trust it if you just changed Nimbus's address or certificate.")
                + "\n\nFingerprint:\n" + fp;
        new AlertDialog.Builder(this).setTitle(host).setMessage(msg).setCancelable(false)
                .setPositiveButton("Trust", (d, w) -> { Trust.pin(this, host, fp); h.proceed(); })
                .setNegativeButton("Cancel", (d, w) -> { h.cancel(); askForUrl("Not connected. Check the address:"); })
                .show();
    }

    private void startEvents() {
        Intent i = new Intent(this, EventService.class);
        try { startForegroundService(i); } catch (Exception ignored) {}
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == REQ_MIC && pendingMic != null) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingMic.deny();
            pendingMic = null;
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        if (code != REQ_FILES || pendingFiles == null) return;
        Uri[] uris = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                uris = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < uris.length; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) uris = new Uri[]{data.getData()};
        }
        pendingFiles.onReceiveValue(uris);
        pendingFiles = null;
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onResume() { super.onResume(); visible = true; web.onResume(); }
    @Override protected void onPause() { super.onPause(); visible = false; web.onPause(); CookieManager.getInstance().flush(); }

    /** Called from the Nimbus page's user menu ("App: server address"), which only shows inside this app. */
    private class Bridge {
        @android.webkit.JavascriptInterface public void changeServer() { runOnUiThread(() -> askForUrl("Your Nimbus address:")); }
    }
}
