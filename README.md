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
   actually works.) Attach an image (e.g. a screenshot of a bug) and it's
   downloaded to a folder *outside* the repo checkout — never committed —
   and referenced by path in the prompt so Claude can read it
   ([src/sessions/attachments.js](src/sessions/attachments.js)).
4. After each reply, **Commit** / **Keep Going** / **Exit** buttons appear:
   - **Commit** commits everything changed since the last commit, opens a
     PR, and immediately merges it (squash) into the repo's default
     branch. The session then re-branches off the freshly-updated default
     branch so it can keep going and commit again later
     ([src/sessions/manager.js](src/sessions/manager.js) `commitAndMerge`).
     Clicking it collapses that message's row to a disabled "Committed ✓".
   - **Keep Going** just collapses that message's row to "Kept Going ✓";
     changes stay uncommitted.
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
6. Bash is blocked by default (see "Tool permissions" below) — if Claude
   wants to run something that needs it, the bot shows an **Approve** /
   **Deny** prompt with what it wanted to run instead of just letting the
   turn fail silently. Approve re-sends the same message with Bash allowed
   for that one attempt; Deny leaves Claude's "I can't do that" as the
   final answer.
7. `/code close` (run inside the session channel) asks **Push** (commit
   anything pending the same way Commit does, then close) or **Exit**
   (close without committing — pending changes are discarded).
8. Idle 4 hours with no messages → pending changes are discarded and the
   session auto-closes, same as Exit.

Session state (channel ↔ repo ↔ branch ↔ Claude conversation id) is
persisted to disk on the `claude-config` volume, so sessions survive a
Coolify restart/redeploy — the bot reloads them on boot and posts a notice
in each still-open channel.

## Persistent picker channel (optional)

`/code set-picker-channel channel:#code` (requires **Manage Channels**)
designates a channel that always shows the repo picker — open it and
there's just a dropdown waiting, no need to run `/code new` each time.

- Picking a repo there works the same as `/code new` (same access check,
  same session creation), but the confirmation — who started a session and
  a link to it — replaces the picker message for ~10 seconds, then it
  reverts back to the plain picker automatically
  ([src/sessions/picker-channel-handlers.js](src/sessions/picker-channel-handlers.js)).
- Anyone with `ALLOWED_ROLE_ID` can use it, same as the ephemeral picker.
- The channel/message ids are persisted (same pattern as session state),
  and the bot re-syncs the message back to the plain picker on boot in
  case it restarted mid-confirmation-window.
- Only one picker channel per server. Running the command again in a
  different channel moves it there; the old channel keeps whatever its
  last message was (nothing un-sets it automatically).

## Activity log (optional)

`/code set-log-channel channel:#audit-log` (requires **Manage Channels**)
makes the bot post one line per significant event to that channel:

- 🟢 a session is opened (who, repo, channel link)
- 📦 a commit happens (who, repo, PR link) — from the Commit button or
  Push-then-close
- 🔴 a session is closed (exit or push-then-close) / ⏱️ auto-closed by the
  4-hour idle timeout
- 🔓 / 🚫 a Bash request is approved or denied
- 🔊 / 🔇 a voice bridge is started or stopped (`/voice join` / `/voice leave`)

Logging is best-effort ([src/log-channel.js](src/log-channel.js)) — if no
log channel is set, or the bot can't reach it for any reason, it silently
does nothing rather than ever failing the real action it's logging.
Config is per-guild, persisted the same way as the picker channel and
welcome panel config.

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

Run once (locally, or via a shell into the deployed container) whenever
the command definitions change:

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

## Voice bridge (Discord ↔ LiveKit, optional)

`/voice join room:<liveKitChannelId> channel:#voice` bridges a Discord
voice channel to a LiveKit channel two-way, via a separate service —
`bridge-discord`, in the Coms server repo (`bridge-discord/README.md`
there is the authoritative reference for how it works and its exact
control API). This bot's [src/voice/](src/voice) is just a thin client
that tells that service to start/stop a pairing; it does no audio work
itself.

- `/voice join room:<id> channel:#voice` — starts a pairing, keyed by the
  Discord voice channel's id (so joining the same channel twice targets
  the same pairing rather than creating a duplicate).
- `/voice leave channel:#voice` — stops it.
- `/voice status channel:#voice` — checks whether a channel is currently
  bridged and each side's connection state.

All three require **Manage Channels** — separate from `ALLOWED_ROLE_ID`
and Manage Roles, since this is infra-level, not session or role access.

Set `BRIDGE_DISCORD_URL` (and `BRIDGE_DISCORD_API_KEY` if that service has
one configured) to enable `/voice` — leave both unset and it's disabled
with a clear message rather than erroring. Deploy `bridge-discord` itself
separately (its own README covers that); this bot never runs voice
audio in-process.

**Status**: the control API client
([src/voice/bridge-client.js](src/voice/bridge-client.js)) is verified
against a mock server matching the documented contract exactly (create,
duplicate-id error, get, leave, idempotent re-leave). The actual
`bridge-discord` service it talks to has not been tested against live
Discord/LiveKit traffic as of this writing — see its own README's status
section before relying on this in production.

## Notes / things to tune

- **Tool permissions**: [src/sessions/session.js](src/sessions/session.js)
  restricts Claude to `Read,Edit,Write,Glob,Grep` and explicitly blocks
  `Bash` via `--disallowedTools` — the actual enforcement mechanism,
  verified directly against the CLI (`--allowedTools` alone does **not**
  reliably block a tool it just omits). Widen this only if you trust
  everyone with the Discord role, and if you ever add another
  shell-execution tool to the environment this runs in, block that too.
- **Bash approval scope**: clicking Approve on a Bash-denial prompt
  unlocks Bash entirely for that one re-run (`--allowedTools` including
  `Bash`, no `--disallowedTools`), not just the specific command Claude
  wanted to run — scoping to the exact command via Claude Code's
  `Bash(<command>)` allow-list syntax couldn't be cleanly verified against
  this bot's actual environment (see the commit history around the
  Approve/Deny feature for why), so the simpler, verified-working version
  shipped instead. Since the conversation resumes right where it left off,
  Claude will almost always just run the same command it originally asked
  for — but the guardrail is "Bash is on for this turn," not "only this
  exact command."
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
