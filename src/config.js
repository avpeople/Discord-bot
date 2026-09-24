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
  },
  workspaceDir: process.env.WORKSPACE_DIR || '/data/workspaces',
  sessionsStatePath: process.env.SESSIONS_STATE_PATH || '/data/claude-config/discord-sessions.json',
  welcomeStatePath: process.env.WELCOME_STATE_PATH || '/data/claude-config/discord-welcome.json',
  pickerChannelStatePath: process.env.PICKER_CHANNEL_STATE_PATH || '/data/claude-config/discord-picker-channel.json',
  // Optional: the bridge-discord control API (see the Coms server repo's
  // bridge-discord/README.md). /voice is disabled entirely if unset.
  bridgeDiscord: {
    url: process.env.BRIDGE_DISCORD_URL || null,
    apiKey: process.env.BRIDGE_DISCORD_API_KEY || null,
  },
};
