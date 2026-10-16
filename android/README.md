# Nimbus Android app

A small Java app (no third-party libraries) that shows your Nimbus in a WebView and adds what a browser
tab can't: microphone access for dictation, file uploads from the phone, haptics, and notifications for
approvals and bot replies (a foreground service listening to `/api/events`).

## Get the app

**Option 1: download** the APK from this repo's Releases page and install it (allow installs from your browser).

**Option 2: build it on your Nimbus server** (Linux x64, no root needed):

```bash
android/setup-toolchain.sh   # once: JDK 17, Android SDK, Gradle into ~/opt (~3 GB)
android/build.sh             # builds a signed APK into public/nimbus.apk
```

Nimbus serves the built app at `https://<your-server>:8443/nimbus.apk`, so open that on your phone to install.
The first build creates your own signing key in `~/opt/android-keystore/`. **Back it up**: Android only installs
updates signed with the same key. (An APK from Releases is signed with a different key, so switching between a
downloaded and a self-built app means uninstalling first.)

## Using it

- **First launch:** enter your server address, e.g. `https://192.168.1.10:8443`. Use the HTTPS port: the
  microphone only works on secure pages.
- **Certificate:** Nimbus uses a self-signed certificate. The app shows its fingerprint once and asks you to
  trust it; after that it only accepts that exact certificate (`Trust.java`), and warns you if it changes.
- **Change the address later:** user menu → **App: server address**.
