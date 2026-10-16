#!/usr/bin/env bash
# One-time: installs everything needed to build the app into ~/opt (no root needed, ~3 GB):
# JDK 17, Android command-line tools + SDK platform 35 + build tools, and Gradle.
set -euo pipefail
OPT="$HOME/opt"; mkdir -p "$OPT"; cd "$OPT"
if [ ! -x jdk17/bin/java ]; then
  echo "Installing JDK 17…"
  curl -fsSL -o jdk.tgz "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  mkdir -p jdk17 && tar xzf jdk.tgz -C jdk17 --strip-components=1 && rm jdk.tgz
fi
export JAVA_HOME="$OPT/jdk17"
if [ ! -x android-sdk/cmdline-tools/latest/bin/sdkmanager ]; then
  echo "Installing Android command-line tools…"
  URL=$(curl -fsSL https://developer.android.com/studio | grep -oE 'https://dl.google.com/android/repository/commandlinetools-linux-[0-9]+_latest.zip' | head -1)
  mkdir -p android-sdk/cmdline-tools && cd android-sdk/cmdline-tools
  curl -fsSL -o t.zip "$URL" && unzip -q t.zip && mv cmdline-tools latest && rm t.zip && cd "$OPT"
fi
echo "Installing SDK packages (accepting Android SDK licenses)…"
yes | android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1 || true
android-sdk/cmdline-tools/latest/bin/sdkmanager --install "platforms;android-35" "build-tools;35.0.0" >/dev/null
if [ ! -x gradle/bin/gradle ]; then
  echo "Installing Gradle…"
  GV=8.10.2; curl -fsSL -o g.zip "https://services.gradle.org/distributions/gradle-$GV-bin.zip"
  unzip -q g.zip && rm g.zip && ln -sfn "$OPT/gradle-$GV" "$OPT/gradle"
fi
echo "Done. Now run android/build.sh"
