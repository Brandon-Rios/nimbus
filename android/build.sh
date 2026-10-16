#!/usr/bin/env bash
# Builds the signed Nimbus Android app and publishes it at /nimbus.apk on the Nimbus server.
#   android/build.sh            (version code = number of commits touching android/)
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="$HOME/opt/jdk17" ANDROID_HOME="$HOME/opt/android-sdk"
[ -x "$HOME/opt/gradle/bin/gradle" ] || { echo "Build tools missing: run android/setup-toolchain.sh first." >&2; exit 1; }

# First build: make your own signing key (kept outside the repo). Back it up; updates need the same key.
KS="$HOME/opt/android-keystore"
if [ ! -f "$KS/keystore.properties" ]; then
  mkdir -p "$KS"; P=$(openssl rand -hex 16)
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS/nimbus.jks" -alias nimbus -keyalg RSA -keysize 4096 -validity 36500 \
    -storepass "$P" -keypass "$P" -dname "CN=Nimbus" >/dev/null 2>&1
  printf "storeFile=%s\nstorePassword=%s\nkeyAlias=nimbus\nkeyPassword=%s\n" "$KS/nimbus.jks" "$P" "$P" > "$KS/keystore.properties"
  chmod 600 "$KS/nimbus.jks" "$KS/keystore.properties"
  echo "Created a signing key in $KS. Back it up."
fi
export NIMBUS_APP_VERSION_CODE=$(( $(git rev-list --count HEAD -- . 2>/dev/null || echo 0) + 1 ))
export NIMBUS_APP_VERSION_NAME="2.$NIMBUS_APP_VERSION_CODE"
echo "sdk.dir=$ANDROID_HOME" > local.properties
"$HOME/opt/gradle/bin/gradle" --quiet assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../public/nimbus.apk
echo "Built Nimbus $NIMBUS_APP_VERSION_NAME -> public/nimbus.apk"
