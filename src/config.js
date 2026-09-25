import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: process.env.DISCORD_GUILD_ID || null,
    allowedRoleId: required('ALLOWED_ROLE_ID'),
  },
  github: {
    token: required('GITHUB_TOKEN'),
    commitName: process.env.GITHUB_COMMIT_NAME || 'Claude Code Bot',
    commitEmail: process.env.GITHUB_COMMIT_EMAIL || 'claude-bot@users.noreply.github.com',
  },
  claude: {
    configDir: process.env.CLAUDE_CONFIG_DIR || '/data/claude-config',
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    // Model alias for sessions that haven't picked one with /code model
    // (e.g. 'sonnet'). Unset = Claude Code's own account default.
    defaultModel: process.env.CLAUDE_MODEL || null,
  },
  workspaceDir: process.env.WORKSPACE_DIR || '/data/workspaces',
  sessionsStatePath: process.env.SESSIONS_STATE_PATH || '/data/claude-config/discord-sessions.json',
  welcomeStatePath: process.env.WELCOME_STATE_PATH || '/data/claude-config/discord-welcome.json',
  pickerChannelStatePath: process.env.PICKER_CHANNEL_STATE_PATH || '/data/claude-config/discord-picker-channel.json',
  logChannelStatePath: process.env.LOG_CHANNEL_STATE_PATH || '/data/claude-config/discord-log-channel.json',
  // Optional: Coolify API, used to post deploy progress into a session
  // channel after Commit merges (see src/coolify.js). Disabled if unset.
  // From inside a Coolify-deployed container, http://coolify:8080 usually
  // works; otherwise use the dashboard's public URL.
  coolify: {
    url: process.env.COOLIFY_URL || null,
    apiToken: process.env.COOLIFY_API_TOKEN || null,
  },
  // Optional: the bridge-discord control API (see the Coms server repo's
  // bridge-discord/README.md). /voice is disabled entirely if unset.
  bridgeDiscord: {
    url: process.env.BRIDGE_DISCORD_URL || null,
    apiKey: process.env.BRIDGE_DISCORD_API_KEY || null,
  },
  // Optional: inbound HTTP endpoint external services (e.g. the Sports
  // GFX site) call to post a studio-monitoring log line. Disabled
  // entirely if NOTIFY_API_KEY is unset — no port is opened.
  notify: {
    port: Number(process.env.NOTIFY_PORT) || 8790,
    apiKey: process.env.NOTIFY_API_KEY || null,
  },
};
