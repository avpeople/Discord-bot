# Claude Code Discord Bot

A Discord bot that gives you a private chat channel backed by Claude Code
against a GitHub repo. `/code new` shows a dropdown of repos, picking one
creates a private text channel with a fresh branch checked out, and you
just talk to Claude in there — it edits files in that checkout. Push
whenever you want to save progress, and `/code close` opens a pull request
from everything pushed and cleans up the channel.

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
   actually works.)
4. After each reply, **Push** / **Keep Going** buttons appear:
   - **Push** commits + pushes everything changed since the last push.
   - **Keep Going** just dismisses the buttons; changes stay uncommitted.
5. `/code close` (run inside the session channel) pushes anything pending,
   opens a GitHub PR from the branch if it has any commits, posts the link,
   and deletes the channel a few seconds later.
6. Idle 4 hours with no messages → any **unpushed** changes are discarded
   and the session auto-closes the same way (PR only if something was
   pushed earlier).

Session state (channel ↔ repo ↔ branch ↔ Claude conversation id) is
persisted to disk on the `claude-config` volume, so sessions survive a
Coolify restart/redeploy — the bot reloads them on boot and posts a notice
in each still-open channel.

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

## Notes / things to tune

- **Tool permissions**: [src/sessions/session.js](src/sessions/session.js)
  restricts Claude to `Read,Edit,Write,Glob,Grep` (no `Bash`) via
  `--allowedTools`, so it can't run arbitrary shell commands on your server.
  Widen this only if you trust everyone with the Discord role.
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
