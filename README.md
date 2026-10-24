# Nimbus

Your personal team of always-on AI bots. Each bot is Claude Code running headless on your
server, under your own Claude login. You talk to them in a web app, they work in the
background, and they stop and ask before anything risky.

- Chat with each bot and watch a live work trace of every tool call
- Group chats where bots @mention each other to hand off work
- Approvals: risky actions (send, pay, delete, push, merge) pause until you approve
- Effort per bot (Low → Max) to control how much of your plan each one uses
- Routines on a schedule (cron), running even when the app is closed
- Per-bot memory the bot updates itself (`MEMORY.md`)
- Themes, accent color, light/dark
- Email + password accounts with optional two-factor codes; reach it from your phone through Twingate
- Android app (build it yourself, see [android/README.md](android/README.md)): dictation, file uploads, notifications
- Voice dictation transcribed on your own server (whisper.cpp), file and image attachments, bots that message each other

No npm packages. Needs only **Node 22.13+** and **Claude Code**.

## Proxmox VE (one line)

In the Proxmox host shell, paste:
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Brandon-Rios/nimbus/main/proxmox/nimbus-lxc.sh)"
```
It asks a few questions (container ID, size, network, who may sign in), creates a Debian 12 LXC container,
installs Nimbus in it as a dedicated `nimbus` user with a service that starts on boot, and prints the address.
Then sign the bots in to Claude once: `pct enter <id>`, `su - nimbus -c claude`, `systemctl restart nimbus`.

## Quick install

On a Linux server (Debian/Ubuntu tested), as the user Nimbus should run as:

```bash
curl -fsSL https://raw.githubusercontent.com/Brandon-Rios/nimbus/main/install.sh | bash
```

It installs Node 22 and Claude Code if needed, helps you log in to Claude, asks who may sign in, optionally
sets up voice dictation and a system service, and prints the address to open. Safe to re-run. Prefer to
read it first? `git clone` the repo and run `./install.sh`.

## Manual setup (Linux VPS or home server)

```bash
# 1. Node 22 and Claude Code
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
npm install -g @anthropic-ai/claude-code

# 2. Log in to Claude once, as the user Nimbus will run as
claude            # finish the login, then type /exit

# 3. Get Nimbus
git clone https://github.com/Brandon-Rios/nimbus.git && cd nimbus
NIMBUS_ALLOWED_EMAILS=you@example.com npm start
# → Nimbus running at http://0.0.0.0:8787
```

Nimbus won't start without a login method: `NIMBUS_ALLOWED_EMAILS` (email accounts) or `NIMBUS_PASSWORD`.

**Email + password:** anyone on `NIMBUS_ALLOWED_EMAILS` can choose **Create account** on the login page.
Nimbus can't send email, so it can't verify an address; only listed emails can sign up, once each.
Everyone who signs in shares the same bots.
You sign in once per device; sessions last 90 days.

## Reach it from your phone (Twingate)

1. In the Twingate admin console, add a **Resource** for the server: its LAN IP or hostname,
   port `8787`, served by a Connector that can reach the server.
2. Give your account access to that Resource and install the Twingate client on your phone.
3. With Twingate on, open `http://<server-ip-or-hostname>:8787` and log in.
4. In Safari/Chrome, choose **Add to Home Screen**.

Keep port 8787 closed to the internet on your router/VPS firewall, so only Twingate can reach it:

```bash
sudo ufw allow from <connector-ip> to any port 8787   # or your LAN subnet, e.g. 192.168.1.0/24
sudo ufw deny 8787
```

**Notifications and HTTPS:** phone notifications need HTTPS, which plain `http://` over Twingate
doesn't give you. Everything else works without it. To get notifications, put Nimbus behind
Caddy with an internal certificate (`tls internal`) and trust Caddy's root certificate on your
phone, then point the Twingate Resource at Caddy's port and set `NIMBUS_SECURE_COOKIE=1`.

## Keep it running (systemd)

Edit `deploy/nimbus.service` (user name, paths, time zone), then:

```bash
sudo cp deploy/nimbus.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nimbus
journalctl -u nimbus -f      # logs
```

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on. Set to the server's LAN IP to limit it further. |
| `NIMBUS_DATA` | `./data` | Database and bot workspaces |
| `NIMBUS_ALLOWED_EMAILS` | — | Comma-separated emails allowed to create an email + password account |
| `NIMBUS_AGENT_URL` / `NIMBUS_AGENT_TOKEN` / `NIMBUS_CALLBACK_URL` | — | Give bots their own computers. See [deploy/computer/README.md](deploy/computer/README.md) |
| `NIMBUS_PASSWORD` | — | Optional single shared password (if you don't want accounts) |
| `NIMBUS_SECURE_COOKIE` | — | Set to `1` when serving over HTTPS |
| `NIMBUS_WINDOW_BUDGET_USD` | — | If set, the sidebar meter shows % of this per 5 hours |
| `NIMBUS_RUN_TIMEOUT_MIN` | `45` | Kill a run that takes longer than this |
| `CLAUDE_BIN` | `claude` | Path to Claude Code |
| `TZ` | system | Time zone routines run in, e.g. `America/New_York` |

## How it works

- Each bot has a folder at `data/bots/<id>/`. Nimbus writes `CLAUDE.md` there from the bot's
  settings, and the bot keeps `MEMORY.md` itself. That folder is its working directory.
- A message runs `claude -p --output-format stream-json --effort <level>` in that folder.
  Direct chats resume the same Claude session so the bot remembers the conversation;
  **New chat** starts fresh (memory is kept). Each bot works on one task at a time; extra tasks queue.
- Bots run with `bypassPermissions` so they don't stall. A `PreToolUse` hook
  (`hooks/approval-hook.js`) checks every tool call against the bot's **Ask me before** rules
  and, on a match, waits until you tap Approve or Reject. A rejection note is passed to the bot.
- Group chats: your message goes to the bots you @mention, otherwise the lead. When a bot's
  reply @mentions another member, that bot runs next (up to 4 hops).
- **Usage** shows Claude Code's reported cost for each run. On a Pro/Max plan you aren't billed that; treat it as a
  relative measure of which bots use the most. Lower effort = less usage.

## Server settings

**Server settings** in the user menu holds the bot-computer VM (agent URL, token, callback URL) and an
optional Proxmox API token. Saved values override the matching env vars and apply without a restart.
With Proxmox set, the Activity panel shows host load and any guests that aren't running.

## Scripting Nimbus from the server

`node bin/nimbus.mjs <METHOD> <path> [json]` calls the API from the server itself without logging in,
e.g. `node bin/nimbus.mjs POST /api/bots '{"name":"Helper"}'`. It uses `data/admin.token`, which Nimbus
creates on start (readable only by its user) and accepts only from localhost.

Attach files and pictures with the paperclip, by pasting, or by dropping them on the chat (up to 10 files, 20 MB each).
They are saved in `data/uploads/` and the bot gets their paths. `POST /api/admin/restart` restarts Nimbus once no bot is running.

Bots can message each other: every bot's CLAUDE.md lists its teammates and how to run `bin/ask-bot.mjs`
(ask and wait for the answer, or `--no-wait` to just pass something on). A bot can't message one that is
waiting on it, and chains stop after 4 bots. Messages show up in the receiving bot's chat.

Nimbus also serves HTTPS on port 8443 (`NIMBUS_HTTPS_PORT`, `0` turns it off) with a self-signed certificate it makes
in `data/tls/`. Bot desktops and phone notifications need HTTPS; accept the browser warning once per device.

Voice dictation: the mic button records in the browser (HTTPS only) and Nimbus transcribes it locally with
whisper.cpp (`~/opt/whisper.cpp`, model `~/opt/whisper-models/ggml-small.en.bin`; override with
`NIMBUS_WHISPER_BIN` / `NIMBUS_WHISPER_MODEL`). Nimbus starts the whisper server itself on 127.0.0.1:8178.

Bot computers: attachments are copied to the bot's computer with each task; the computer dialog has a Files tab
to download what the bot saved (~/Downloads, ~/work); idle computers sleep after 2 h (`NIMBUS_COMPUTER_SLEEP_MIN`, 0 = never)
and wake on the next task; Server settings → Update computers rebuilds them with the latest Claude Code and Chromium.

Approvals: `@self-email` in a bot's Always-allow lets it email only you; time waiting for approval doesn't count toward the
run limit. Routines can be quiet checks (only report problems) and are skipped when the plan's 5-hour limit is over 85%
(`NIMBUS_ROUTINE_GUARD_PCT`). `data/shared/HOMELAB.md` is included in every bot's brief. Nightly encrypted backups:
`bin/backup.mjs` (restore with `--restore`). Read-aloud uses Piper (`~/opt/piper`). `bin/team-status.mjs` summarizes the team.

Secrets that look like API keys, tokens or passwords are masked as `[REDACTED]` before chat
messages, run logs and approvals are saved. The bot still receives your original message.

## Giving bots tools

Bots have everything Claude Code has on that server: files, shell, web search and fetch.
For Gmail, Calendar, GitHub, Slack and so on, add MCP servers to Claude Code on the server
(`claude mcp add --scope user ...`) and every bot can use them. Connector tools show up as
`mcp__<server>__<tool>`, which is what the approval rules match (e.g. `mcp__gmail__send*`).

To give one bot a code repo, put the path in its instructions ("Work in /home/me/myapp"),
or clone the repo inside its folder.

## Privacy

- Whether your conversations may be used to train Claude is an **account setting**: claude.ai → Settings →
  Privacy → **Help improve Claude**. Turn it off there; it covers Claude Code (and so every Nimbus bot) for that account.
- Nimbus also starts every bot with Claude Code's telemetry, error reporting and feedback surveys turned off.

## Security notes

- Bots can run any command as the Nimbus user. Run Nimbus as a dedicated user that only has
  access to what the bots should touch.
- Approval rules are a safety net, not a sandbox. Review the defaults in each bot's settings.
- Don't open port 8787 to the internet; let Twingate be the only way in. The password is a second lock.
- Failed logins are rate-limited (8 tries, then 15 minutes). Logins last 90 days per device; **Log out** in the sidebar ends one.
