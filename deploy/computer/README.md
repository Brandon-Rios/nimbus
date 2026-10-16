# Bot computers

Gives each bot its own desktop: its own files, browser and saved sign-ins, which you can
watch and take over from Nimbus. All of them live inside **one** Proxmox VM as Docker
containers, so your Proxmox list only ever shows that one VM.

```
Nimbus (your PC) ──HTTP──▶ agent.mjs (VM :8788) ──docker──▶ nimbus-bot-1, nimbus-bot-2, …
      ▲                                                        │ desktop on :3101, :3102, …
      └──────────── approval checks (NIMBUS_CALLBACK_URL) ─────┘
```

## 1. Create the VM in Proxmox

- **OS:** Ubuntu Server 24.04 LTS (or Debian 12)
- **CPU / RAM / disk:** 4 cores, 8 GB RAM, 64 GB disk is enough for several bots.
  Each running desktop uses roughly 0.5–1 GB RAM while a bot is busy.
- **Name:** `nimbus-computers`
- Give it a fixed IP on your LAN (DHCP reservation), e.g. `192.168.1.50`.

## 2. Install Docker, Node and Claude Code on the VM

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo useradd -m -s /bin/bash nimbus && sudo usermod -aG docker nimbus
```

## 3. Copy Nimbus onto the VM and build the bot computer image

Copy this whole `nimbus` folder to `/opt/nimbus` on the VM (for example with `scp -r`), then:

```bash
sudo chown -R nimbus:nimbus /opt/nimbus
cd /opt/nimbus && sudo -u nimbus docker build -f deploy/computer/Dockerfile -t nimbus-computer .
```

The first build downloads a desktop image and Chromium, so it takes a few minutes.

## 4. Get a Claude Code token for the bots

Bots inside the containers need to sign in to Claude. On any machine where you're logged in
to Claude Code (your PC is fine):

```bash
claude setup-token
```

It prints a long-lived token starting with `sk-ant-oat…`. Treat it like a password.

## 5. Configure and start the agent

```bash
sudo -u nimbus tee /opt/nimbus/deploy/computer/agent.env >/dev/null <<'EOF'
AGENT_TOKEN=pick-a-long-random-string
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
TZ=America/Chicago
EOF
sudo chmod 600 /opt/nimbus/deploy/computer/agent.env
sudo cp /opt/nimbus/deploy/computer/nimbus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nimbus-agent
curl -s -H "Authorization: Bearer pick-a-long-random-string" http://localhost:8788/health
```

The last line should print `{"ok":true,"docker":"…"}`.

## 6. Point Nimbus at it

Add to Nimbus's `.env` on your PC, then restart Nimbus:

```
NIMBUS_AGENT_URL=http://192.168.1.50:8788
NIMBUS_AGENT_TOKEN=pick-a-long-random-string
NIMBUS_CALLBACK_URL=http://<your-PC's-LAN-IP>:8787
```

`NIMBUS_CALLBACK_URL` is how a bot's computer asks Nimbus for your approval before risky
actions, so the VM must be able to reach your PC on port 8787. On Windows, allow it through
the firewall (PowerShell as admin):

```powershell
New-NetFirewallRule -DisplayName "Nimbus 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -RemoteAddress 192.168.1.50 -Action Allow
```

## 7. Use it

In Nimbus, open a bot's settings and turn on **Own computer**. A monitor button appears in
the chat header: open it to start the computer, watch the screen, or sign the bot into
websites. The bot's next task runs on its computer.

- **Storage:** each bot's home folder is a Docker volume (`nimbus-bot-<id>`), so files and
  sign-ins survive restarts. **Delete computer** in Nimbus erases it.
- **Security:** keep ports 8788 and 3100+ reachable only from your LAN / Twingate. Each
  screen has its own password (shown in Nimbus). Bots can run anything inside their own
  container, but not on the VM or your other machines.
- **Memory:** Nimbus sends the bot's instructions and memory in with each task and saves
  its updated memory back afterwards, so the Memory screen in Nimbus stays current.
