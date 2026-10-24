#!/usr/bin/env bash
# Nimbus installer for Linux (Debian/Ubuntu tested). Safe to re-run: it skips what's already done.
#
#   curl -fsSL https://raw.githubusercontent.com/Brandon-Rios/nimbus/main/install.sh | bash
#   # or, from a clone:  ./install.sh
#
# Non-interactive: set answers in the environment, e.g.
#   NIMBUS_EMAILS=you@example.com NIMBUS_SERVICE=yes NIMBUS_DICTATION=no ./install.sh --yes
set -euo pipefail

REPO_URL="${NIMBUS_REPO_URL:-https://github.com/Brandon-Rios/nimbus.git}"
DIR="${NIMBUS_DIR:-$HOME/nimbus}"
YES=0; [ "${1:-}" = "--yes" ] && YES=1

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# ask VAR "Question" "default" — uses $VAR if already set; reads from the terminal even under curl | bash.
ask() {
  local var=$1 q=$2 def=${3:-} ans
  if [ -n "${!var:-}" ]; then return; fi
  if [ $YES = 1 ] || [ ! -r /dev/tty ]; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "  $q${def:+ [$def]}: " ans < /dev/tty || true
  printf -v "$var" '%s' "${ans:-$def}"
}
yesno() { case "${1,,}" in y|yes|true|1) return 0;; *) return 1;; esac; }
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; if [ "$(id -u)" != 0 ]; then have sudo && SUDO="sudo"; fi

[ "$(uname -s)" = Linux ] || die "Nimbus runs on Linux. (On Windows use WSL; on macOS run server.js by hand.)"

bold "1/6  Getting Nimbus"
if [ -f "./server.js" ] && [ -f "./runner.js" ]; then DIR="$PWD"; ok "Using this folder: $DIR"
elif [ -d "$DIR/.git" ]; then ok "Already at $DIR"; git -C "$DIR" pull --ff-only -q || warn "Couldn't update $DIR (local changes?)"
else
  have git || { [ -n "$SUDO" ] && $SUDO apt-get install -y -qq git >/dev/null; } || die "Install git first."
  git clone -q "$REPO_URL" "$DIR" && ok "Cloned into $DIR"
fi
cd "$DIR"

bold "2/6  Node.js 22 and Claude Code"
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -ge 22 ]; then ok "Node $(node -v)"
else
  [ -n "$SUDO" ] || [ "$(id -u)" = 0 ] || die "Node 22+ is needed and installing it needs sudo. Install Node 22, then re-run."
  have apt-get || die "Install Node 22+ with your package manager, then re-run."
  echo "  Installing Node 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs >/dev/null && ok "Node $(node -v)"
fi
export PATH="$HOME/.npm-global/bin:$PATH"
if have claude; then ok "Claude Code $(claude --version 2>/dev/null | head -1)"
else
  echo "  Installing Claude Code…"
  if npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; then :
  else  # no write access to the global npm folder: use one in the home directory
    npm config set prefix "$HOME/.npm-global" && npm install -g @anthropic-ai/claude-code >/dev/null
    export PATH="$HOME/.npm-global/bin:$PATH"
    grep -q '.npm-global/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
  fi
  # npm may have put it in a folder this shell doesn't know yet (e.g. ~/.npm-global/bin).
  export PATH="$(npm prefix -g 2>/dev/null)/bin:$HOME/.npm-global/bin:$PATH"; hash -r
  grep -q '.npm-global/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
  have claude && ok "Claude Code installed" || die "Claude Code didn't install. Try: npm install -g @anthropic-ai/claude-code"
fi
if [ -f "$HOME/.claude/.credentials.json" ]; then ok "Claude Code is logged in"
else
  warn "Claude Code isn't logged in yet. It opens now: sign in with your Claude account, then type /exit."
  if [ $YES = 0 ] && [ -r /dev/tty ]; then claude < /dev/tty > /dev/tty || true; fi
  [ -f "$HOME/.claude/.credentials.json" ] && ok "Logged in" || warn "Not logged in. Run 'claude' later, as this user, before using bots."
fi

bold "3/6  Login for the Nimbus web app"
if [ -f .env ] && grep -qE '^(NIMBUS_ALLOWED_EMAILS|NIMBUS_PASSWORD)=' .env; then ok "Keeping the login settings in .env"
else
  ask NIMBUS_EMAILS "Email(s) allowed to create an account (comma-separated)" ""
  if [ -z "$NIMBUS_EMAILS" ]; then
    NIMBUS_PASSWORD_VALUE=${NIMBUS_PASSWORD_VALUE:-$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' || date +%s%N)}
    warn "No email given, so Nimbus uses one shared password: $NIMBUS_PASSWORD_VALUE  (saved in .env)"
  fi
  ask NIMBUS_TZ "Time zone for routines" "$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
  umask 077
  {
    echo "# Nimbus settings. Keep this file private."
    [ -n "$NIMBUS_EMAILS" ] && echo "NIMBUS_ALLOWED_EMAILS=$NIMBUS_EMAILS" || echo "NIMBUS_PASSWORD=$NIMBUS_PASSWORD_VALUE"
    echo "TZ=$NIMBUS_TZ"
  } > .env
  ok "Wrote .env"
fi

bold "4/6  Voice dictation (optional, ~1 GB, runs on this server)"
ask NIMBUS_DICTATION "Set up voice dictation with whisper.cpp? (y/n)" "y"
if yesno "$NIMBUS_DICTATION"; then
  if [ -x "$HOME/opt/whisper.cpp/build/bin/whisper-server" ] && [ -f "$HOME/opt/whisper-models/ggml-small.en.bin" ]; then ok "Already set up"
  else
    have make && have g++ || { [ -n "$SUDO" ] && $SUDO apt-get install -y -qq build-essential >/dev/null; } || die "Install a C++ compiler (build-essential) for dictation, or answer n."
    mkdir -p "$HOME/opt" && cd "$HOME/opt"
    if ! have cmake && [ ! -x cmake/bin/cmake ]; then
      echo "  Getting CMake…"
      V=$(curl -fsSL https://api.github.com/repos/Kitware/CMake/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4 | tr -d v)
      curl -fsSL "https://github.com/Kitware/CMake/releases/download/v$V/cmake-$V-linux-$(uname -m).tar.gz" | tar xz
      ln -sfn "$HOME/opt/cmake-$V-linux-$(uname -m)" cmake
    fi
    CMAKE=$(command -v cmake || echo "$HOME/opt/cmake/bin/cmake")
    [ -d whisper.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp
    echo "  Building whisper.cpp (a few minutes)…"
    (cd whisper.cpp && "$CMAKE" -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null \
      && "$CMAKE" --build build -j"$(nproc)" --target whisper-server >/dev/null)
    mkdir -p whisper-models
    [ -f whisper-models/ggml-small.en.bin ] || { echo "  Downloading the speech model (488 MB)…"; curl -fsSL -o whisper-models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin; }
    cd "$DIR"; ok "Dictation ready (Nimbus starts it automatically)"
  fi
else ok "Skipped (you can re-run this later)"; fi

bold "5/6  Keep Nimbus running"
ask NIMBUS_SERVICE "Install it as a system service that starts on boot? Needs sudo. (y/n)" "y"
if yesno "$NIMBUS_SERVICE"; then
  [ -n "$SUDO" ] || [ "$(id -u)" = 0 ] || die "Installing the service needs sudo. Re-run with NIMBUS_SERVICE=no to skip."
  NPM_BIN=$(npm prefix -g)/bin
  $SUDO tee /etc/systemd/system/nimbus.service >/dev/null <<UNIT
[Unit]
Description=Nimbus - personal AI bot team
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$DIR
ExecStart=$(command -v node) --no-warnings --env-file-if-exists=.env server.js
Environment=HOME=$HOME
Environment=PATH=$NPM_BIN:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  # Lets Nimbus restart itself after updates (only this one command).
  echo "$(id -un) ALL=(root) NOPASSWD: /usr/bin/systemctl restart nimbus" | $SUDO tee /etc/sudoers.d/nimbus-restart >/dev/null
  $SUDO chmod 440 /etc/sudoers.d/nimbus-restart
  $SUDO systemctl daemon-reload && $SUDO systemctl enable --now nimbus >/dev/null 2>&1 && $SUDO systemctl restart nimbus
  sleep 3; systemctl is-active --quiet nimbus && ok "Running as the 'nimbus' service (logs: journalctl -u nimbus -f)" || warn "Service didn't start; see: journalctl -u nimbus -n 50"
else ok "Skipped. Start it yourself with:  cd $DIR && npm start"; fi

bold "6/6  Android app (optional)"
echo "  Download the APK from the GitHub Releases page, or build your own on this server:"
echo "    $DIR/android/setup-toolchain.sh && $DIR/android/build.sh"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
bold "Done!"
echo "  Open  https://${IP:-<this-server>}:8443   (accept the self-signed certificate once)"
echo "   or   http://${IP:-<this-server>}:8787"
[ -n "${NIMBUS_EMAILS:-}" ] && echo "  Choose 'Create account' with $NIMBUS_EMAILS on the login page."
echo "  Keep ports 8443/8787 off the internet; use Twingate or a VPN to reach it from your phone. See README.md."
