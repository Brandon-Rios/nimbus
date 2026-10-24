#!/usr/bin/env bash
# Nimbus on Proxmox VE: creates a Debian 12 LXC container and installs Nimbus in it.
# Run on the Proxmox host shell (as root):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Brandon-Rios/nimbus/main/proxmox/nimbus-lxc.sh)"
# Non-interactive: set any of these first, then add --yes:
#   CTID HOSTNAME CORES RAM_MB DISK_GB STORAGE BRIDGE IP (dhcp or 192.168.1.50/24) GW EMAILS TZ DICTATION(y/n)
set -euo pipefail

REPO="${NIMBUS_REPO_URL:-https://github.com/Brandon-Rios/nimbus.git}"
YES=0; DRY=0
for a in "$@"; do case "$a" in --yes) YES=1;; --dry-run) DRY=1;; esac; done
B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'
msg() { printf '%s\n' " ${B}${1}${N}"; }
ok() { printf '%s\n' "  ${G}✓${N} $1"; }
warn() { printf '%s\n' "  ${Y}!${N} $1"; }
die() { printf '%s\n' "  ${R}✗ $1${N}" >&2; exit 1; }
run() { if [ $DRY = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

cat <<'ART'

   _  _  _           _
  | \| |(_) _ __  | |__  _  _  ___
  | .` || || '  \ | '_ \| || |(_-<
  |_|\_||_||_|_|_||_.__/ \_,_|/__/   Proxmox LXC installer

ART
[ "$(id -u)" = 0 ] || die "Run this as root on the Proxmox host."
command -v pct >/dev/null || die "This isn't a Proxmox VE host (pct not found)."

# ---------- questions (whiptail like the community helper scripts, or plain prompts) ----------
ask() { # ask VAR "Question" default
  local var=$1 q=$2 def=$3 v
  [ -n "${!var:-}" ] && return
  if [ $YES = 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  if command -v whiptail >/dev/null; then
    v=$(whiptail --title "Nimbus LXC" --inputbox "$q" 10 70 "$def" 3>&1 1>&2 2>&3) || die "Cancelled."
  else read -r -p "  $q [$def]: " v; v=${v:-$def}; fi
  printf -v "$var" '%s' "$v"
}
pick_storage() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | head -1; }

ask CTID "Container ID" "$(pvesh get /cluster/nextid)"
ask HOSTNAME "Hostname" "nimbus"
ask CORES "CPU cores" "4"
ask RAM_MB "Memory (MB)" "4096"
ask DISK_GB "Disk (GB)" "20"
ask STORAGE "Storage for the container disk" "$(pick_storage rootdir)"
ask BRIDGE "Network bridge" "vmbr0"
ask IP "IP address: dhcp, or static like 192.168.1.50/24" "dhcp"
[ "$IP" != dhcp ] && ask GW "Gateway" "$(ip route | awk '/default/ {print $3; exit}')"
ask EMAILS "Email(s) allowed to create a Nimbus account (comma-separated)" ""
ask TZ "Time zone" "$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
ask DICTATION "Voice dictation, runs locally, ~1 GB (y/n)" "n"
[ -n "$EMAILS" ] || die "Enter at least one email (it's how you sign in)."
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists."
[ -n "$STORAGE" ] || die "No storage for containers found."

# ---------- template ----------
msg "1/5  Debian 12 template"
TSTORE=$(pick_storage vztmpl); [ -n "$TSTORE" ] || die "No storage that holds container templates (enable 'Container template' on one, e.g. local)."
run pveam update >/dev/null || true
TPL=$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)
[ -n "$TPL" ] || die "Couldn't find the Debian 12 template."
if pveam list "$TSTORE" | grep -q "$TPL"; then ok "$TPL already on $TSTORE"; else run pveam download "$TSTORE" "$TPL" >/dev/null && ok "Downloaded $TPL"; fi

# ---------- container ----------
msg "2/5  Creating container $CTID ($HOSTNAME)"
NET="name=eth0,bridge=$BRIDGE,ip=$IP"; [ "$IP" != dhcp ] && NET="$NET,gw=$GW"
run pct create "$CTID" "$TSTORE:vztmpl/$TPL" --hostname "$HOSTNAME" --cores "$CORES" --memory "$RAM_MB" --swap 512 \
  --rootfs "$STORAGE:$DISK_GB" --net0 "$NET" --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian \
  --description "Nimbus: personal team of AI bots (Claude Code). https://github.com/Brandon-Rios/nimbus" >/dev/null
run pct start "$CTID"
ok "Container created and started"

msg "3/5  Waiting for network"
if [ $DRY = 0 ]; then
  for i in $(seq 1 60); do pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null' 2>/dev/null && break; sleep 2; done
  pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null' || die "The container has no internet/DNS. Check the bridge and IP settings."
fi
ok "Online"

# ---------- Nimbus ----------
msg "4/5  Installing Nimbus (a few minutes)"
IN() { run pct exec "$CTID" -- bash -c "$1"; }
IN "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl git sudo ca-certificates openssl locales >/dev/null"
IN "id nimbus >/dev/null 2>&1 || useradd -m -s /bin/bash nimbus"
# Temporary sudo for the installer (Node.js and the service); removed again below.
IN "echo 'nimbus ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/nimbus-install && chmod 440 /etc/sudoers.d/nimbus-install"
IN "timedatectl set-timezone '$TZ' 2>/dev/null || ln -sf /usr/share/zoneinfo/$TZ /etc/localtime"
IN "su - nimbus -c 'git clone -q $REPO ~/nimbus && cd ~/nimbus && NIMBUS_EMAILS=\"$EMAILS\" NIMBUS_TZ=\"$TZ\" NIMBUS_SERVICE=yes NIMBUS_DICTATION=$DICTATION ./install.sh --yes'"
IN "rm -f /etc/sudoers.d/nimbus-install"   # the installer leaves only: sudo systemctl restart nimbus
ok "Nimbus installed and running as the 'nimbus' user"

# ---------- done ----------
msg "5/5  Done"
CIP=$([ $DRY = 1 ] && echo "<container-ip>" || pct exec "$CTID" -- hostname -I | awk '{print $1}')
cat <<DONE

  ${G}Nimbus is running in container $CTID.${N}

  One last step: sign Nimbus's bots in to Claude (your Claude Pro/Max account):
     pct enter $CTID
     su - nimbus -c claude          # finish the login in your browser, then type /exit
     systemctl restart nimbus

  Then open:  ${B}https://$CIP:8443${N}   (accept the self-signed certificate once)
  Choose "Create account" with: $EMAILS

  Keep it off the internet: reach it from your phone with Twingate, Tailscale or a VPN.
  Android app: see the Releases page of the repo.
DONE
