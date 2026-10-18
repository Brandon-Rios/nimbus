package dev.nimbus.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.webkit.CookieManager;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

/** Approve / Reject buttons on an approval notification: answers Nimbus without opening the app. */
public class ApprovalReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        final int approvalId = intent.getIntExtra("approvalId", 0);
        final int notifId = intent.getIntExtra("notifId", 0);
        final boolean approve = "approve".equals(intent.getStringExtra("decision"));
        final PendingResult pending = goAsync();
        new Thread(() -> {
            String msg;
            try {
                String base = Trust.serverUrl(ctx);
                URL url = new URL(base + "/api/approvals/" + approvalId);
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                if (c instanceof HttpsURLConnection) {
                    ((HttpsURLConnection) c).setSSLSocketFactory(Trust.socketFactory(ctx, url.getHost()));
                    ((HttpsURLConnection) c).setHostnameVerifier(Trust.PINNED_HOST);
                }
                String cookie = CookieManager.getInstance().getCookie(base);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "application/json");
                c.setDoOutput(true);
                c.setConnectTimeout(10000); c.setReadTimeout(15000);
                byte[] body = ("{\"decision\":\"" + (approve ? "approve" : "reject") + "\""
                        + (approve ? "" : ",\"note\":\"Rejected from a phone notification\"") + "}").getBytes(StandardCharsets.UTF_8);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
                int code = c.getResponseCode();
                msg = code == 200 ? (approve ? "Approved" : "Rejected") : code == 409 ? "Already decided" : "Nimbus said " + code;
            } catch (Exception e) {
                msg = "Couldn’t reach Nimbus";
            }
            ctx.getSystemService(NotificationManager.class).cancel(notifId);
            final String toast = msg;
            new android.os.Handler(ctx.getMainLooper()).post(() -> Toast.makeText(ctx, toast, Toast.LENGTH_SHORT).show());
            pending.finish();
        }).start();
    }
}
