package dev.nimbus.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Settings, plus trust-on-first-use for Nimbus's self-signed HTTPS certificate: the first time the
 * user accepts a server's certificate its SHA-256 fingerprint is saved, and after that only a
 * certificate with that exact fingerprint is accepted (both in the WebView and in EventService).
 */
final class Trust {
    static final String DEFAULT_URL = "https://";

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("nimbus", Context.MODE_PRIVATE); }

    static String serverUrl(Context c) {
        String u = prefs(c).getString("url", "");
        return u.isEmpty() ? null : u.replaceAll("/+$", "");
    }
    static void setServerUrl(Context c, String url) { prefs(c).edit().putString("url", url.trim().replaceAll("/+$", "")).apply(); }

    static String pinned(Context c, String host) { return prefs(c).getString("pin:" + host, null); }
    static void pin(Context c, String host, String fp) { prefs(c).edit().putString("pin:" + host, fp).apply(); }

    static String fingerprint(Certificate cert) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length; i++) { if (i > 0) sb.append(':'); sb.append(String.format("%02X", d[i])); }
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    /** For HttpsURLConnection: accept only the pinned certificate for this host. */
    static SSLSocketFactory socketFactory(Context c, String host) throws Exception {
        final String pin = pinned(c, host);
        TrustManager tm = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String a) {}
            public void checkServerTrusted(X509Certificate[] chain, String a) throws java.security.cert.CertificateException {
                if (pin == null || chain.length == 0 || !pin.equals(fingerprint(chain[0])))
                    throw new java.security.cert.CertificateException("Certificate not trusted in the Nimbus app");
            }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{tm}, null);
        return ctx.getSocketFactory();
    }
    /** The pinned fingerprint already identifies the server, so the hostname check is not needed. */
    static final HostnameVerifier PINNED_HOST = (h, s) -> true;

    private Trust() {}
}
