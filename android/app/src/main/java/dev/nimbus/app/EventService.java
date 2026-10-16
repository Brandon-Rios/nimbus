package dev.nimbus.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

/**
 * Listens to Nimbus's live event stream (/api/events) and notifies when a bot needs approval, or a
 * bot replies while the app isn't open. Runs as a foreground service so Android keeps it connected.
 */
public class EventService extends Service {
    private static final String CH_STATUS = "status", CH_ALERTS = "alerts";
    private volatile boolean running = false;
    private Thread thread;
    private final Map<String, String> botNames = new HashMap<>();
    private int nextId = 100;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_MIN));
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Approvals and replies", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(alerts);
        Notification n = new Notification.Builder(this, CH_STATUS).setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("Nimbus").setContentText("Listening for approvals and replies")
                .setContentIntent(open(null)).setOngoing(true).build();
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        if (!running) { running = true; thread = new Thread(this::loop, "nimbus-events"); thread.start(); }
        return START_STICKY;
    }

    @Override public void onDestroy() { running = false; if (thread != null) thread.interrupt(); super.onDestroy(); }

    private HttpURLConnection connect(String path) throws Exception {
        String base = Trust.serverUrl(this);
        URL url = new URL(base + path);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        if (c instanceof HttpsURLConnection) {
            ((HttpsURLConnection) c).setSSLSocketFactory(Trust.socketFactory(this, url.getHost()));
            ((HttpsURLConnection) c).setHostnameVerifier(Trust.PINNED_HOST);
        }
        String cookie = CookieManager.getInstance().getCookie(base);
        if (cookie != null) c.setRequestProperty("Cookie", cookie);
        c.setConnectTimeout(15000);
        return c;
    }

    private void loadBotNames() {
        try {
            HttpURLConnection c = connect("/api/state");
            c.setReadTimeout(15000);
            JSONArray bots = new JSONObject(read(c)).getJSONArray("bots");
            for (int i = 0; i < bots.length(); i++) botNames.put(String.valueOf(bots.getJSONObject(i).getInt("id")), bots.getJSONObject(i).getString("name"));
        } catch (Exception ignored) {}
    }

    private static String read(HttpURLConnection c) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String line; while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    private void loop() {
        int backoff = 2000;
        while (running) {
            try {
                if (Trust.serverUrl(this) == null) { Thread.sleep(10000); continue; }
                loadBotNames();
                HttpURLConnection c = connect("/api/events");
                c.setReadTimeout(90000); // the server pings every 25 s
                if (c.getResponseCode() == 401) { Thread.sleep(60000); continue; } // logged out: wait for the user
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    backoff = 2000;
                    String event = null, line;
                    while (running && (line = r.readLine()) != null) {
                        if (line.startsWith("event:")) event = line.substring(6).trim();
                        else if (line.startsWith("data:") && event != null) { handle(event, line.substring(5).trim()); event = null; }
                    }
                }
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    private void handle(String event, String data) {
        try {
            if (event.equals("state_changed")) { loadBotNames(); return; }
            if (!event.equals("message")) return;
            JSONObject m = new JSONObject(data);
            String author = m.optString("author"), kind = m.optString("kind"), thread = m.optString("thread");
            String name = botNames.containsKey(author) ? botNames.get(author) : "A bot";
            if (kind.equals("approval")) {
                JSONObject a = new JSONObject(m.optString("body"));
                if ("pending".equals(a.optString("status"))) notify(name + " needs approval", a.optString("tool"), thread);
            } else if (kind.equals("text") && !author.equals("user") && !author.equals("system") && !MainActivity.visible) {
                String body = m.optString("body").replaceAll("\\s+", " ");
                notify(name, body.length() > 180 ? body.substring(0, 180) + "…" : body, thread);
            }
        } catch (Exception ignored) {}
    }

    private PendingIntent open(String thread) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (thread != null) i.putExtra("thread", thread);
        return PendingIntent.getActivity(this, thread == null ? 0 : thread.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void notify(String title, String text, String thread) {
        Notification n = new Notification.Builder(this, CH_ALERTS).setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open(thread)).setAutoCancel(true).build();
        getSystemService(NotificationManager.class).notify(nextId++, n);
    }
}
