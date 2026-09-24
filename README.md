# Claude Code Discord Bot

A Discord bot that runs Claude Code headlessly against your GitHub repos.
`/code repo:owner/name prompt:"..."` clones the repo, lets Claude Code make
the requested changes, commits them to a new branch, and opens a pull
request — posting progress and the PR link back in Discord.

## How it works

1. Someone with the allowed Discord role runs `/code`.
2. The bot clones (or updates) the repo into a persistent workspace volume,
   checks out a new `claude/<timestamp>` branch.
3. It runs `claude -p "<prompt>" --permission-mode acceptEdits` in that
   directory (see [src/claude-runner.js](src/claude-runner.js)) so Claude
   Code can read/edit/write files without needing interactive approval.
4. Changes are committed, pushed, and a PR is opened via the GitHub API.
5. The bot edits its Discord reply with progress, then the final PR link.

## 1. Create the Discord application

1. https://discord.com/developers/applications → New Application.
2. **Bot** tab → Reset Token → copy it → `DISCORD_TOKEN`.
3. **OAuth2 → General** → copy Client ID → `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator** → scopes `bot`, `applications.commands` →
   permissions: Send Messages, Read Message History → open the generated
   URL to invite the bot to your server.
5. Create (or pick) a role in your server that trusted people have (e.g.
   `@dev`) → copy its ID (enable Developer Mode in Discord, right-click the
   role) → `ALLOWED_ROLE_ID`.

## 2. GitHub access

Create a fine-grained Personal Access Token (or a GitHub App installation
token) scoped only to the repos you want the bot to touch, with
Contents: Read & write and Pull requests: Read & write. Put it in
`GITHUB_TOKEN`.

## 3. Configure environment

Copy [.env.example](.env.example) to `.env` for local testing, or set the
same variables in Coolify's environment settings. See that file for the
full list.

## 4. Register slash commands

Run once locally (or as a one-off Coolify command) whenever commands change:

```bash
npm install
npm run register
```

Set `DISCORD_GUILD_ID` while iterating (guild commands update instantly);
drop it for a global rollout (~1 hour to propagate).

## 5. Deploy on Coolify

1. New Resource → Docker Compose, pointing at this repo's
   [docker-compose.yml](docker-compose.yml). It already declares the two
   persistent volumes (`claude-config`, `workspaces`) Coolify will create and
   keep across redeploys.
2. Set the env vars from `.env.example` in Coolify's environment tab — the
   compose file passes each one through via `${VAR}`, so anything not set
   there won't reach the container.
3. Deploy.

### One-time Claude login (subscription auth)

This setup uses your Claude Pro/Max subscription rather than API billing,
so the container needs an interactive login once. After the first deploy:

1. Open a shell into the running container (Coolify → your app →
   **Terminal**, or `docker exec -it <container> sh`).
2. Run:
   ```bash
   claude login
   ```
3. Follow the printed URL, approve on another device/browser, done.

Because `CLAUDE_CONFIG_DIR=/data/claude-config` is on a persistent volume,
this survives redeploys/restarts — you only need to do it again if the
volume is destroyed or the session expires.

If you'd rather not deal with re-authenticating on a headless server, set
`ANTHROPIC_API_KEY` instead (API billing, no login step needed) — the
bot picks it up automatically and skips subscription auth.

## Notes / things to tune

- **Tool permissions**: [src/claude-runner.js](src/claude-runner.js) restricts
  Claude to `Read,Edit,Write,Glob,Grep` (no `Bash`) via `--allowedTools`, so
  it can't run arbitrary shell commands on your server. Widen this only if
  you trust everyone with the Discord role.
- **Concurrency**: the bot only allows one job per Discord channel at a time
  ([src/index.js](src/index.js)); it doesn't queue across channels, so two
  people in two channels can still run jobs concurrently on the same
  container. Add a global lock there if you want strict single-job behavior.
- **Timeouts**: Discord deferred replies are valid for ~15 minutes; very
  large tasks may need to be split into smaller prompts.
