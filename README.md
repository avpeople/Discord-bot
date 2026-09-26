# Claude Code Discord Bot

A Discord bot that gives you a private chat channel backed by Claude Code
against a GitHub repo. `/code new` shows a dropdown of repos, picking one
creates a private text channel with a fresh branch checked out, and you
just talk to Claude in there — it edits files in that checkout. Hit
**Commit** whenever you want a change to go live: it commits, opens a PR,
and immediately merges it into the default branch — which, since Coolify
auto-deploys on push to that branch, ships it.

**This means Commit has no manual review step** — clicking it puts
Claude's changes into your default branch (and live, for anything Coolify
deploys from it) right away. A PR is still opened and merged (so there's
a diff on GitHub you can look back at afterward), but nothing stops you
before the merge happens. Only give the allowed Discord role to people you
trust to make that call.

## How it works

1. `/code new` → bot lists repos the GitHub token can access → you pick one.
2. Bot creates a private channel (visible only to you + the allowed role)
   under a **Claude Sessions** category, clones the repo, and checks out a
   new `claude/session-<id>` branch.
3. Every message you send in that channel is passed to Claude Code
   ([src/sessions/session.js](src/sessions/session.js)). Each message spawns a
   fresh `claude -p --resume <id>` process scoped to the session's checkout —
   short-lived per message, but `--resume` gives it the full prior
   conversation, so it feels continuous. (A single long-running `claude`
   process fed over stdin does **not** behave like a chat REPL — verified
   directly against the CLI — so this per-message-resume approach is what
   actually works.) Attach an image (e.g. a screenshot of a bug), a
   text/log/code file or a PDF and it's downloaded to a folder *outside* the repo checkout — never committed —
   and referenced by path in the prompt so Claude can read it
   ([src/sessions/attachments.js](src/sessions/attachments.js)).
   While Claude works, the "Thinking..." message updates live with what
   it's doing (reading a file, running a command, ...) and has a **Stop**
   button that kills the turn (file changes so far are kept). Messages
   sent while it's busy are queued and sent together as one follow-up
   turn. Each reply ends with a stats line — tool calls, tokens, and
   Claude Code's reported cost for that turn plus the session total (an
   estimate on subscription logins); the log channel gets the session
   total on close.
4. After each reply, **Commit** / **Keep Going** / **Show Changes** /
   **Fresh Start** / **Exit** buttons appear:
   - **Commit** commits everything changed since the last commit, opens a
     PR, and immediately merges it (squash) into the repo's default
     branch. The session then re-branches off the freshly-updated default
     branch so it can keep going and commit again later
     ([src/sessions/manager.js](src/sessions/manager.js) `commitAndMerge`).
     Clicking it collapses that message's row to a disabled "Committed ✓".
   - **Keep Going** just collapses that message's row to "Kept Going ✓";
     changes stay uncommitted.
   - **Show Changes** privately lists the files Commit would include,
     with the full diff attached as `changes.diff`.
   - **Fresh Start** clears Claude's conversation history (files are
     kept). Every message resends the whole conversation, so long chats
     get steadily more expensive — this resets that.
   - **↩️ Undo This Reply's Changes** (a second row, only under replies
     that changed files) puts the files back exactly as they were before
     that reply — edits reverted, new files removed, deleted files
     restored; ignored files like `node_modules` are left alone. Only the
     latest such reply can be undone, and not after a Commit. The bot
     snapshots the working tree into a scratch git index before each turn
     (`snapshotWorkingTree` in [src/repo.js](src/repo.js)), and tells
     Claude on the next message that its changes were undone.
   - **Exit** closes the session (discarding anything not already
     committed) and removes the channel. Unlike Commit/Keep Going, Exit
     stays live on every past reply — not just the newest — so you can
     bail out from any point in the conversation, even after using
     Commit/Keep Going on that same message.
5. If Claude offers a genuine multiple-choice decision, real Discord
   buttons appear instead of prose — click one and it's sent back into the
   conversation as your next message
   ([src/sessions/reply.js](src/sessions/reply.js) `parseOptionsBlock`).
   An Exit button is included alongside the options. If Claude has several
   distinct questions to ask, it's instructed to ask them one at a time
   rather than listing them all in one reply — see `OPTIONS_SYSTEM_PROMPT`
   in [src/sessions/session.js](src/sessions/session.js).
6. Claude can run shell commands (Bash) without asking — see "Tool
   permissions" below.
7. `/code close` (run inside the session channel) asks **Push** (commit
   anything pending the same way Commit does, then close) or **Exit**
   (close without committing — pending changes are discarded).
8. Idle 4 hours with no messages → pending changes are discarded and the
   session auto-closes, same as Exit. A warning with a **Keep Alive**
   button is posted 15 minutes before.
9. After Commit merges, the message has a **⏪ Revert This Merge**
   button: after a confirm, it opens GitHub's revert PR for that merge and
   merges it. If Coolify is configured (see below), the bot also follows
   the deploy each merge triggers and posts its progress and result —
   with the last log lines if it failed.
10. `/code status` lists every open session (repo, owner, idle time,
   model, cost so far). `/code init` has Claude write a `CLAUDE.md` of
   project notes for the repo — Claude Code reads it at the start of
   every session instead of re-exploring the project; the welcome message
   suggests it when a repo doesn't have one.
11. `/code model` switches the session between Sonnet, Opus and Haiku
   (Sonnet is much cheaper than Opus). `CLAUDE_MODEL` in `.env` sets the
   default for new sessions.

Session state (channel ↔ repo ↔ branch ↔ Claude conversation id) is
persisted to disk on the `claude-config` volume, so sessions survive a
Coolify restart/redeploy — the bot reloads them on boot and posts a notice
in each still-open channel.

## Persistent picker channel (optional)

`/code set-picker-channel channel:#code` (requires **Manage Channels**)
designates a channel that always shows the repo picker — open it and
there's just a dropdown waiting, no need to run `/code new` each time.

- Picking a repo there works the same as `/code new` (same access check,
  same session creation). The picker stays put; the confirmation — who
  started a session and a link to it — is posted underneath it and deleted
  after ~10 seconds
  ([src/sessions/picker-channel-handlers.js](src/sessions/picker-channel-handlers.js)).
  The Chat with Claude button there does the same.
- Anyone with `ALLOWED_ROLE_ID` can use it, same as the ephemeral picker.
- The channel/message ids are persisted (same pattern as session state),
  and the bot re-renders the picker message on boot so it picks up any
  changes from the deploy.
- Only one picker channel per server. Running the command again in a
  different channel moves it there; the old channel keeps whatever its
  last message was (nothing un-sets it automatically).
- The picker (both this one and `/code new`'s) shows the Claude account's
  usage above the dropdown: a 5-hour session bar and a weekly bar with
  their reset times, like Claude Code's `/usage`. The picker channel's
  message refreshes every 3 minutes
  ([src/claude-usage.js](src/claude-usage.js)). It reads the `claude login`
  credentials and an undocumented Claude Code endpoint, so it's hidden
  with an API key login and may break if Anthropic changes that endpoint.
  The bot never refreshes the login token itself, so while no session has
  run for a few hours the last known numbers are shown, marked as such.

## Deploy updates from Coolify (optional)

Set `COOLIFY_URL` and `COOLIFY_API_TOKEN` (create the token in Coolify
under **Keys & Tokens → API tokens**; read access is enough). After a
Commit, Push-then-close or Revert merges, the bot finds the Coolify
app(s) deploying that repo's default branch (matching `git_repository` +
`git_branch`), follows the deploy triggered by the merge, and edits a
message in the session channel as it goes: queued → building → ✅
deployed / ❌ failed (with the log tail). Results also go to the activity
log. It gives up if no deploy starts within 3 minutes (auto-deploy off)
or it runs past 30. From inside a Coolify-deployed container
`http://coolify:8080` usually reaches Coolify; otherwise use the
dashboard's URL. See [src/coolify.js](src/coolify.js).

**Deployment log.** `/code set-coolify-log-channel channel:#coolify-logs`
makes the bot post every deployment on the Coolify server there —
whatever started it (Push Live, a GitHub push, the dashboard, the
Redeploy button). One message per deployment, edited as it goes: 🔨
deploying → ✅ deployed (with how long it took) / ❌ failed (with the log
tail) / ⚪ cancelled. It polls every 20 seconds and doesn't re-post history
after a restart ([src/coolify-monitor.js](src/coolify-monitor.js)).

**Server Status controls.** Under Server Status, the *Manage an app*
dropdown opens that app privately with **📜 Logs** (last 30 lines),
**🔄 Restart**, **🚀 Redeploy** and **⏹️ Stop** / **▶️ Start**, each behind
a confirm step; the bot then follows the resulting Coolify deployment in
the same message ([src/coolify-controls.js](src/coolify-controls.js)).
These need the Coolify API token to have **write** and **deploy**
permissions (read is enough for status and logs).

**PR titles.** Push Live's PR title and description are written by
Claude (Haiku) from the diff
([src/sessions/pr-writer.js](src/sessions/pr-writer.js)), falling back to
a generic title if that fails.

## Activity log (optional)

`/code set-log-channel channel:#audit-log` (requires **Manage Channels**)
makes the bot post one line per significant event to that channel:

- 🟢 a session is opened (who, repo, channel link)
- 📦 a commit happens (who, repo, PR link) — from the Commit button or
  Push-then-close
- 🔴 a session is closed (exit or push-then-close) / ⏱️ auto-closed by the
  4-hour idle timeout

Logging is best-effort ([src/log-channel.js](src/log-channel.js)) — if no
log channel is set, or the bot can't reach it for any reason, it silently
does nothing rather than ever failing the real action it's logging.
Config is per-guild, persisted the same way as the picker channel and
welcome panel config.

## Studio monitoring (optional)

`/studio set-log-channel channel:#studio-events` (requires **Manage
Channels**) sets where studio/GFX monitoring events get logged — a
separate channel from the Claude Code activity log above, since these
come from different systems entirely.

Events reach Discord via an inbound HTTP endpoint external services call
directly — the bot doesn't poll anything. See
[src/notify-server.js](src/notify-server.js):

- `POST /notify` with header `x-api-key: <NOTIFY_API_KEY>` and body
  `{ "message": "...", "guildId": "...", "kind": "studio" }` — `guildId`
  defaults to `DISCORD_GUILD_ID` if omitted, `kind` defaults to `"studio"`.
- Entirely disabled (no port opened) unless `NOTIFY_API_KEY` is set —
  opt-in, inert by default.
- The port is public (not on an internal Docker network with whatever's
  calling it — see the commit history for why: each Coolify app gets its
  own isolated network by default, and joining a shared one was more
  infra work than this needed for a first version), so the API key is the
  only thing gating it — pick a long random value.

The Sports GFX site (`Websites/Sports Gfx`) is the first caller: its
login route (`app/api/auth/login/route.ts`) fire-and-forgets a call to
this endpoint via `lib/discord-notify.ts` on every successful login,
configured with `DISCORD_NOTIFY_URL` / `DISCORD_NOTIFY_API_KEY` in that
repo's own env. Any other studio system can call the same endpoint the
same way — that's why `kind` exists, so future sources don't need new
storage/command plumbing on this side, just `/studio set-log-channel`
(or a new command, if a source ever wants its own channel rather than
sharing the `studio` one).

### LiveU status board

Set `LIVEU_EMAIL` / `LIVEU_PASSWORD` (the LiveU Solo portal login) and the
bot polls LiveU every 15s ([src/liveu/](src/liveu/)):

- `/studio set-liveu-channel channel:#liveu-status` — posts a summary at
  the top (🔴 2 live · 🟢 1 online · ⚫ 5 offline), then one box per
  online unit:
  status, total bitrate, video input, SIMs up, and each connection's
  bitrate/signal. Boxes are edited in place, only when something changed.
- **Go Live** streams to the unit's selected destination (the box shows
  which) and **Stop** ends it — same API calls as the Studio Patch app,
  each with a confirm step. Needs `LIVEU_ROLE_ID` (else `ALLOWED_ROLE_ID`).
  Both presses are logged to the studio log.
- The studio log (`/studio set-log-channel`) gets: unit online/offline,
  went live/stopped, video input lost/back, SIM lost/connected, and
  bitrate under the threshold for 2 polls in a row / recovered.
  `/studio liveu-alert-bitrate kbps:1500` sets the threshold (0 = off).
- `/studio liveu-raw unit:<name>` downloads the unit's raw API responses.
  These LiveU endpoints are the Solo portal's private ones, not a
  documented API. Field names follow what the Studio Patch app reads,
  with fallbacks in [src/liveu/parse.js](src/liveu/parse.js) — if a stat
  shows `—` or looks wrong, compare against the raw dump and add the real
  field name there.

### MediaMTX

With the AVP media-mtx site configured ([src/mediamtx/](src/mediamtx/),
same endpoints as the Rugby GFX site and Studio Patch):

- `/studio set-mediamtx-channel channel:#mediamtx` — a panel in its own
  channel: each stream, live or not, with its Cam → server and server →
  studio status (🟢 ok, 🟡 low bitrate with the Mbps, 🔴 offline).
- `MEDIAMTX_URL` / `MEDIAMTX_USERNAME` / `MEDIAMTX_PASSWORD` — the stream
  list for that panel, and each LiveU box gets a **Set destination
  → MediaMTX stream** dropdown (live streams first, plus **Other…** to
  type a name). Picking one creates an SRT destination
  `<srtAddress>?streamid=publish:<stream>` and selects it on the unit, so
  the next Go Live streams there. Disabled while the unit is live. Each
  pick adds a destination to the LiveU account, like Studio Patch does.
- `MEDIAMTX_EVENTS_API_KEY` (created on the site's Events page) — stream
  online/offline and low-bitrate/recovered events go to the studio log,
  and the panel's IN (camera → server) and OUT (server → studio) come
  from these.
- `MEDIAMTX_API_URL` (+ `MEDIAMTX_API_USER` / `MEDIAMTX_API_PASSWORD`) —
  optional, MediaMTX's own API (e.g. `http://host:9997`). When set, IN/OUT
  come from it instead and cover every connection (OUT shows how many are
  pulling — a laptop counts, not just the studio), and every stream gets a
  measured bitrate. MediaMTX needs `api: yes` and an `apiAddress` the bot
  can reach.

Panel dots: 🟢 in and out, 🟡 one of them, ⚫ neither.

## Welcome panel (role requests)

Separate from the Claude Code sessions: `/welcome` manages a self-serve
role-request panel with an admin approval step, useful for e.g. letting
people request the Claude Code access role themselves rather than you
manually assigning it.

- `/welcome add-role role:@Dev label:"Claude Code Access"` — adds a role
  as a requestable button (label defaults to the role's own name).
- `/welcome remove-role role:@Dev` — removes one.
- `/welcome set-approval-channel channel:#role-requests` — where requests
  get posted with Approve/Deny buttons.
- `/welcome post channel:#welcome title:"..." description:"..."` — posts
  (or re-posts) the panel as a bordered embed listing the requestable
  roles, with buttons below. Title/description are optional (default to
  "Welcome to \<server\>!" and a generic prompt). Run it again after
  adding/removing roles to refresh an existing panel.

All four require the **Manage Roles** Discord permission — separate from
`ALLOWED_ROLE_ID`, which only gates Claude Code session access.

When someone clicks a role button: a request card goes to the approval
channel, they get an ephemeral confirmation. An admin (anyone with Manage
Roles) clicks **Approve** to grant the role or **Deny** to skip it; the
card updates in place to show who decided and when, and the requester
gets a DM if their DMs are open (best-effort — a closed DM doesn't block
the approval).

Config (which roles, which approval channel) is stored per-guild in
[src/welcome/store.js](src/welcome/store.js), persisted to disk the same
way as session state — no redeploy needed to change it.

## 1. Create the Discord application

1. https://discord.com/developers/applications → New Application.
2. **Bot** tab → Reset Token → copy it → `DISCORD_TOKEN`.
3. **Bot** tab → under **Privileged Gateway Intents**, enable
   **Message Content Intent**. Required — without it, messages you type in
   session channels arrive empty and Claude never sees them.
4. **OAuth2 → General** → copy Application ID → `DISCORD_CLIENT_ID`.
5. **OAuth2 → URL Generator** → scopes `bot`, `applications.commands` →
   bot permissions: Send Messages, Read Message History, Manage Channels
   (needed to create/delete session channels) → open the generated URL to
   invite the bot to your server.
6. Create (or pick) a role in your server for people allowed to use this
   (e.g. `@dev`) → copy its ID (enable Developer Mode in Discord, right-click
   the role) → `ALLOWED_ROLE_ID`.
7. Right-click your server icon → Copy Server ID → `DISCORD_GUILD_ID`
   (recommended while testing — guild-scoped commands register instantly).

## 2. GitHub access

Create a fine-grained Personal Access Token scoped to the repos you want
selectable in `/code new`, with **Contents: Read & write** and
**Pull requests: Read & write**. Put it in `GITHUB_TOKEN`.

To add or remove repos later, edit the token's repo list on GitHub
(Settings → Developer settings → Fine-grained tokens) — no redeploy or
token change needed, `/code new`'s repo list reflects it live.

## 3. Configure environment

Copy [.env.example](.env.example) to `.env` for local testing, or set the
same variables in Coolify's environment settings.

## 4. Register slash commands

Automatic: the bot registers its commands every time it starts, so a
redeploy is enough when the command definitions change. To do it by hand
anyway (locally, or via a shell into the deployed container):

```bash
npm install
npm run register
```

Set `DISCORD_GUILD_ID` while iterating (guild commands update instantly);
drop it for a global rollout (~1 hour to propagate).

## 5. Deploy on Coolify

1. New Resource → Docker Compose, pointing at this repo's
   [docker-compose.yml](docker-compose.yml). It declares the two persistent
   volumes (`claude-config`, `workspaces`) Coolify will create and keep
   across redeploys.
2. Set the env vars from `.env.example` in Coolify's environment tab — the
   compose file passes each one through via `${VAR}`, so anything not set
   there won't reach the container.
3. Deploy.

### One-time Claude login (subscription auth)

This setup uses your Claude Pro/Max subscription rather than API billing,
so the container needs an interactive login once. After the first deploy:

1. SSH into the server (or open Coolify's container terminal) and exec in:
   ```bash
   docker exec -it <container_id> sh
   ```
2. Run:
   ```bash
   claude login
   ```
3. Follow the printed URL, approve on another device/browser, done.

Because `CLAUDE_CONFIG_DIR=/data/claude-config` is on a persistent volume,
this survives redeploys/restarts — you only need to do it again if the
volume is destroyed or the session expires.

If you'd rather not deal with re-authenticating on a headless server, set
`ANTHROPIC_API_KEY` instead (API billing, no login step needed) — the bot
picks it up automatically and skips subscription auth.

## Coms bridge (`/voice`, optional)

Listen and talk on AVP coms from a Discord voice channel. The bot does the
audio itself ([src/coms/](src/coms/)): it joins the Discord voice channel
and the coms channel's LiveKit room, and mixes audio both ways.

- **Setup**: in the coms admin console, Bridges tab, create a bridge (e.g.
  "Discord") and copy its key. Set `COMS_API_URL` (the coms API, e.g.
  `https://api-com.avp.nz`) and `COMS_BRIDGE_KEY`. The bot then shows as
  an online bridge in the admin console.
- `/voice join channel:#voice coms:<channel>` (Manage Channels) — the coms
  channel is picked from a list. Posts a control panel in the voice
  channel's chat: who's on coms, and **Talk** / **Leave** buttons.
- **Listen** is always on: everyone in the voice channel hears coms.
  **Talk** sends the voice channel's speakers out on coms while it's on —
  off by default so Discord chatter can't leak onto coms. Only people in
  the voice channel (or channel managers) can press the buttons.
- `/voice leave`, `/voice status`. The bridge also leaves by itself after
  2 minutes with nobody in the voice channel.
- One bridge per server (Discord allows a bot in one voice channel per
  server). Starting, stopping and Talk on/off are logged to the studio log.

Audio is 48 kHz stereo end to end (no resampling): Discord's Opus is
decoded, speakers mixed, and published as one LiveKit track; every coms
track is mixed and played into Discord. Neither side hears itself back.

## Notes / things to tune

- **Tool permissions**: [src/sessions/session.js](src/sessions/session.js)
  allows `Read,Edit,Write,Glob,Grep,Bash,WebSearch,WebFetch,TodoWrite`,
  so Claude can run shell commands inside the session's repo checkout
  and look things up on the web without asking. The
  [Dockerfile](Dockerfile) installs Python, build tools, `gh`, `jq` and
  `zip`/`unzip` for it to use via Bash. Asked to look at another repo
  for reference, Claude shallow-clones it with `gh` into a sibling
  `<session dir>-refs` folder (outside the checkout, so it's never
  committed; deleted when the session closes) — it can reach any repo
  `GITHUB_TOKEN` can read. Anyone with
  the Discord role can therefore run arbitrary commands in the bot's
  container — only give that role to people you trust. Subagents
  (`Agent`/`Task`) are blocked via `--disallowedTools` so each Discord
  chat stays a single Claude Code conversation (`--allowedTools` alone
  does **not** reliably block a tool it just omits — verified against the
  CLI).
- **Concurrency**: one message is processed at a time per session
  (`session.busy` guard) — sending another message while Claude is still
  replying gets a "still working" notice rather than queuing or racing.
- **Restart recovery**: works because each message is a fresh
  `claude --resume` process rather than one long-lived process — there's
  nothing in memory that a restart can lose except the idle timer, which
  just restarts fresh. See [src/sessions/store.js](src/sessions/store.js).
- **Idle timeout**: 4 hours, hardcoded in
  [src/sessions/session.js](src/sessions/session.js) (`IDLE_TIMEOUT_MS`).
- **Repo directories**: each session gets its own clone under
  `WORKSPACE_DIR/<owner>/<repo>/<session-id>/`, deleted when the session
  closes — concurrent sessions on the same repo never collide.
- **Image attachments**: only `image/png`, `image/jpeg`, `image/webp`,
  `image/gif` up to 15MB are picked up (see `IMAGE_CONTENT_TYPES` /
  `MAX_IMAGE_BYTES` in [src/sessions/attachments.js](src/sessions/attachments.js));
  other attachment types are silently ignored for now.
