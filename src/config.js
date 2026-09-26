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
  liveuStatePath: process.env.LIVEU_STATE_PATH || '/data/claude-config/discord-liveu.json',
  // Optional: Coolify API, used to post deploy progress into a session
  // channel after Commit merges (see src/coolify.js). Disabled if unset.
  // From inside a Coolify-deployed container, http://coolify:8080 usually
  // works; otherwise use the dashboard's public URL.
  coolify: {
    url: process.env.COOLIFY_URL || null,
    apiToken: process.env.COOLIFY_API_TOKEN || null,
  },
  // Optional: the AVP coms server, for /voice (Discord voice ↔ coms). The
  // bot joins as a bridge: create one in the coms admin console (Bridges
  // tab) and use its key. /voice is disabled entirely if unset.
  coms: {
    apiUrl: process.env.COMS_API_URL || null,
    bridgeKey: process.env.COMS_BRIDGE_KEY || null,
    // Who can open/end a bridge from the coms landing panel (besides channel managers).
    roleId: process.env.COMS_ROLE_ID || process.env.ALLOWED_ROLE_ID,
  },
  comsStatePath: process.env.COMS_STATE_PATH || '/data/claude-config/discord-coms.json',
  // Optional: inbound HTTP endpoint external services (e.g. the Sports
  // GFX site) call to post a studio-monitoring log line. Disabled
  // entirely if NOTIFY_API_KEY is unset — no port is opened.
  notify: {
    port: Number(process.env.NOTIFY_PORT) || 8790,
    apiKey: process.env.NOTIFY_API_KEY || null,
  },
  // Optional: LiveU Solo account the studio LiveU board and alerts read
  // from (see src/liveu/). Disabled entirely if unset. Go Live / Stop
  // need LIVEU_ROLE_ID, falling back to ALLOWED_ROLE_ID.
  liveu: {
    email: process.env.LIVEU_EMAIL || null,
    password: process.env.LIVEU_PASSWORD || null,
    roleId: process.env.LIVEU_ROLE_ID || process.env.ALLOWED_ROLE_ID,
  },
  // Optional: the AVP media-mtx site (see src/mediamtx/). The login gives
  // the stream list + SRT address (LiveU destination dropdown); the events
  // API key gives stream online/offline/low-bitrate events.
  mediamtx: {
    url: process.env.MEDIAMTX_URL || null,
    username: process.env.MEDIAMTX_USERNAME || null,
    password: process.env.MEDIAMTX_PASSWORD || null,
    eventsUrl: process.env.MEDIAMTX_EVENTS_URL || null,
    eventsApiKey: process.env.MEDIAMTX_EVENTS_API_KEY || null,
    // MediaMTX's own API (e.g. http://host:9997) — every reader and bytes in/out, for real IN/OUT and bitrate.
    apiUrl: process.env.MEDIAMTX_API_URL || null,
    apiUser: process.env.MEDIAMTX_API_USER || null,
    apiPassword: process.env.MEDIAMTX_API_PASSWORD || null,
  },
};
