# 🤖 Aurora Bot — Multi-User Minecraft AFK Bot Control Panel

Aurora Bot lets you run a private control panel where each logged-in user
manages their **own, isolated** Minecraft AFK bot ([mineflayer](https://github.com/PrismarineJS/mineflayer)):
its own server connection, its own AuthMe login, its own chat log, and its
own saved farm route. Nobody sees or controls anyone else's bot.

There is **no public sign-up**. The only way to get an account is for the
admin to create one.

---

### 🔐 How accounts work

- **Admin account** — defined entirely by environment variables
  (`ADMIN_USERNAME` / `ADMIN_PASSWORD`). It is never written to disk. Log in
  as the admin to reach `/admin` and create real user accounts.
- **User accounts** — created only by the admin, from the `/admin` panel.
  Passwords are hashed with bcrypt and stored in `data/users.json`. Each user
  gets their own bot the moment they log in.

---

### 🚀 Setup

**1. Install dependencies**
```bash
npm install
```

**2. Configure your environment**
```bash
cp .env.example .env
```
Then edit `.env`:
```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=pick-a-strong-password
SESSION_SECRET=paste-a-random-64-char-hex-string-here
PORT=3000
NODE_ENV=production
```
Generate a strong `SESSION_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
> On Railway (or any host that gives you a dashboard for variables), set
> these as **Service Variables** instead of a `.env` file — Railway's own
> `PORT` will be picked up automatically.

To use a permitted SOCKS5 VPN/proxy only after the server rejects the normal
connection for its IP limit, set `MC_PROXY` as a service variable. Use
`socks5://host:port` or `socks5://username:password@host:port`. The bot starts
normally, detects the IP-limit kick, and uses the proxy on the next reconnect.

**3. Run it**
```bash
npm start
```
The panel logs `Control panel running on port ...` and `Admin login: <name>`
on boot. It refuses to start if `ADMIN_PASSWORD` or `SESSION_SECRET` is
missing, rather than running unprotected.

**4. Log in as admin, create users**
Go to `/login`, sign in with your admin credentials, then open `/admin` from
the topbar to create an account for anyone who should run their own bot.
They log in at the same `/login` page with the credentials you gave them.

**5. Each user configures their own bot**
After logging in, a user opens the "Server settings" panel on the
dashboard, enters their Minecraft server's host/port/username/version, and
clicks **Start bot**. This is completely separate per account.

---

### 📦 Persistent data (important for redeploys)

By default, `data/` lives next to the app and is **wiped on every redeploy**
on most PaaS platforms (Railway, etc.) because their filesystems are
ephemeral. To keep users and bot configs across redeploys:

- **Railway**: attach a [Volume](https://docs.railway.com/reference/volumes),
  then set `RAILWAY_VOLUME_MOUNT_PATH` to its mount path (e.g. `/data`).
- **VPS**: no action needed — a normal VPS disk already persists; just make
  sure the `data/` folder isn't inside a path that gets wiped by your deploy
  script.

---

### 🧠 Bot features

✅ Auto login/register on AuthMe servers
✅ Accepts teleport requests automatically
✅ AFK movement with a watchdog that un-sticks the bot if it stalls
✅ Replies to public chat and whispers (`!help`, `!ping`, "hello", etc.)
✅ Auto-reconnects if kicked or disconnected
✅ Save/replay farm routes with named checkpoints
✅ Fully isolated per logged-in user — no shared state between accounts

---

### 🛠 What changed in this version

- Real login system (session-based, bcrypt-hashed user passwords), no
  self-registration anywhere in the app.
- Admin account bootstrapped purely from environment variables; admin
  panel to create/remove user accounts.
- Every bot is now per-user: its own connection, config, logs, and route,
  isolated by session and Socket.IO room.
- **Fixed:** the bot freezing in place. Pathfinding's `path_reset` event only
  retried movement when the reason was `'stuck'` — every other reset reason
  (`dig_error`, `no_scaffolding_blocks`, etc.) silently killed AFK movement
  for good. Now any reset reason triggers a retry, plus a 15-second watchdog
  forces a fresh movement target if the bot's position hasn't changed.
- **Fixed:** a race condition in "Reconnect" that could spin up two bot
  instances back-to-back instead of properly waiting for the old one to
  fully disconnect first.
- **Fixed:** the Minecraft version dropdown could silently render empty if
  a future `minecraft-data` release ever dropped the exact pinned version
  string.
- **Fixed:** the config form (host/username/etc.) losing your edits before
  you could save — the panel now tracks unsaved edits properly instead of
  overwriting fields on every telemetry tick.
- Added basic login rate-limiting, secure session cookies in production,
  `trust proxy` for correct behavior behind Railway's reverse proxy, and
  process-level crash guards (`uncaughtException`/`unhandledRejection`) plus
  graceful shutdown on `SIGTERM`/`SIGINT`.
- UI: dedicated login page, admin panel, user chip + logout in the topbar,
  button loading states, and a proper confirm dialog for destructive actions
  (stopping the bot, clearing a route, removing a user).

---

### 📜 License

Open-source, free to use, modify, and share.
