import { Client, GatewayIntentBits, Partials, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { SessionManager } from './sessions/manager.js';
import {
  hasAccess,
  handleCodeNew,
  handleCodeClose,
  handleRepoSelected,
  handleSessionMessage,
  handleCommitButton,
  handleKeepGoingButton,
  handleExitButton,
  handleOptionButton,
  handleClosePushButton,
  handleCloseExitButton,
  handleStopButton,
  handleShowChangesButton,
  handleFreshStartButton,
  handleKeepAliveButton,
  handleCodeModel,
  handleCodeStatus,
  handleCodeInit,
  handleUndoButton,
  handleRevertButton,
  handleRevertConfirmButton,
  sendIdleWarning,
  REPO_SELECT_ID,
  COMMIT_BUTTON_ID,
  KEEP_GOING_BUTTON_ID,
  EXIT_BUTTON_ID,
  OPTION_BUTTON_PREFIX,
  CLOSE_PUSH_BUTTON_ID,
  CLOSE_EXIT_BUTTON_ID,
  STOP_BUTTON_ID,
  SHOW_CHANGES_BUTTON_ID,
  FRESH_START_BUTTON_ID,
  KEEP_ALIVE_BUTTON_ID,
  UNDO_BUTTON_PREFIX,
  REVERT_BUTTON_PREFIX,
  REVERT_CONFIRM_PREFIX,
} from './sessions/handlers.js';
import {
  handleWelcomeAddRole,
  handleWelcomeRemoveRole,
  handleWelcomeSetApprovalChannel,
  handleWelcomePost,
  handleRoleRequestButton,
  handleApproveButton,
  handleDenyButton,
  isRequestButton,
  isApproveButton,
  isDenyButton,
} from './welcome/handlers.js';
import { handleVoiceJoin, handleVoiceLeave, handleVoiceStatus } from './voice/handlers.js';
import {
  handleSetPickerChannel,
  handlePersistentRepoSelected,
  resyncPickerChannel,
} from './sessions/picker-channel-handlers.js';
import { PERSISTENT_REPO_SELECT_ID } from './sessions/repo-picker.js';
import { handleSetLogChannel, handleSetStudioLogChannel } from './log-channel-handlers.js';
import { initLogChannel } from './log-channel.js';
import { startNotifyServer } from './notify-server.js';
import { registerCommands } from './register-commands.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const sessionManager = new SessionManager();

sessionManager.onIdleWarning = async (session) => {
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel) return;
  await sendIdleWarning(channel, session).catch((err) => console.error('Failed to post idle warning:', err));
};

sessionManager.onIdleExpire = async (session) => {
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel) return;
  await channel
    .send('⏱️ This session was closed after 4 hours idle. Start a new one with `/code new`.')
    .catch((err) => console.error('Failed to post idle-close notice:', err));
};

// Button IDs from the old Bash Approve/Deny prompt, which no longer exists
// (Bash is always allowed now). Used to strip leftover buttons from
// messages posted before that change.
const LEGACY_BASH_BUTTON_IDS = new Set(['claude-session:approve-bash', 'claude-session:deny-bash']);

/** Removes leftover Bash Approve/Deny buttons from the bot's recent messages in `channel`. */
async function stripLegacyBashButtons(channel) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;
  for (const message of messages.values()) {
    if (message.author.id !== client.user.id) continue;
    const hasLegacyButton = message.components.some((row) =>
      row.components?.some((c) => LEGACY_BASH_BUTTON_IDS.has(c.customId)),
    );
    if (hasLegacyButton) {
      await message.edit({ components: [] }).catch((err) => console.error('Failed to strip old Bash buttons:', err));
    }
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Keep Discord's slash commands in sync with this deploy — no manual `npm run register` needed.
  await registerCommands().catch((err) => console.error('Failed to register slash commands:', err));
  initLogChannel(client);
  startNotifyServer();

  const restored = sessionManager.restore();
  if (restored.length > 0) {
    console.log(`Restored ${restored.length} session(s) from disk.`);
  }
  for (const session of restored) {
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (channel) {
      await stripLegacyBashButtons(channel);
      await channel
        .send('🔄 Bot restarted — this session is back and remembers the conversation. Carry on!')
        .catch((err) => console.error('Failed to post restore notice:', err));
    }
  }

  // Reset any picker channel back to the plain picker in case the bot
  // restarted mid-confirmation-window (e.g. right after someone picked a
  // repo, before the 10s revert fired).
  for (const guild of client.guilds.cache.values()) {
    await resyncPickerChannel(client, guild.id);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'code') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'new') return handleCodeNew(interaction);
      if (sub === 'close') return handleCodeClose(interaction, sessionManager);
      if (sub === 'model') return handleCodeModel(interaction, sessionManager);
      if (sub === 'status') return handleCodeStatus(interaction, sessionManager);
      if (sub === 'init') return handleCodeInit(interaction, sessionManager);
      if (sub === 'set-picker-channel') return handleSetPickerChannel(interaction);
      if (sub === 'set-log-channel') return handleSetLogChannel(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'welcome') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add-role') return handleWelcomeAddRole(interaction);
      if (sub === 'remove-role') return handleWelcomeRemoveRole(interaction);
      if (sub === 'set-approval-channel') return handleWelcomeSetApprovalChannel(interaction);
      if (sub === 'post') return handleWelcomePost(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'voice') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'join') return handleVoiceJoin(interaction);
      if (sub === 'leave') return handleVoiceLeave(interaction);
      if (sub === 'status') return handleVoiceStatus(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'studio') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'set-log-channel') return handleSetStudioLogChannel(interaction);
      return;
    }

    if (interaction.isButton() && isRequestButton(interaction.customId)) {
      return handleRoleRequestButton(interaction);
    }

    if (interaction.isButton() && isApproveButton(interaction.customId)) {
      return handleApproveButton(interaction);
    }

    if (interaction.isButton() && isDenyButton(interaction.customId)) {
      return handleDenyButton(interaction);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === REPO_SELECT_ID) {
      return handleRepoSelected(interaction, sessionManager);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === PERSISTENT_REPO_SELECT_ID) {
      return handlePersistentRepoSelected(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === COMMIT_BUTTON_ID) {
      return handleCommitButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === KEEP_GOING_BUTTON_ID) {
      return handleKeepGoingButton(interaction);
    }

    if (interaction.isButton() && interaction.customId === EXIT_BUTTON_ID) {
      return handleExitButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId.startsWith(OPTION_BUTTON_PREFIX)) {
      return handleOptionButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === CLOSE_PUSH_BUTTON_ID) {
      return handleClosePushButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === CLOSE_EXIT_BUTTON_ID) {
      return handleCloseExitButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === STOP_BUTTON_ID) {
      return handleStopButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === SHOW_CHANGES_BUTTON_ID) {
      return handleShowChangesButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === FRESH_START_BUTTON_ID) {
      return handleFreshStartButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId.startsWith(UNDO_BUTTON_PREFIX)) {
      return handleUndoButton(interaction, sessionManager);
    }

    // 'claude-session:revert-confirm:…' doesn't start with 'claude-session:revert:',
    // so these two prefix checks can't match each other's buttons.
    if (interaction.isButton() && interaction.customId.startsWith(REVERT_CONFIRM_PREFIX)) {
      return handleRevertConfirmButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId.startsWith(REVERT_BUTTON_PREFIX)) {
      return handleRevertButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === KEEP_ALIVE_BUTTON_ID) {
      return handleKeepAliveButton(interaction, sessionManager);
    }

    // Any old Approve/Deny button the startup sweep missed just removes itself when clicked.
    if (interaction.isButton() && LEGACY_BASH_BUTTON_IDS.has(interaction.customId)) {
      return interaction.update({ components: [] });
    }
  } catch (err) {
    console.error('Unhandled interaction error:', err);
    const payload = { content: `❌ Something went wrong: ${err.message}`.slice(0, 2000) };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!sessionManager.getByChannel(message.channelId)) return;
  if (!hasAccess({ member: message.member })) return;

  try {
    await handleSessionMessage(message, sessionManager);
  } catch (err) {
    console.error('Unhandled session message error:', err);
    await message.reply(`❌ Something went wrong: ${err.message}`.slice(0, 2000)).catch(() => {});
  }
});

client.login(config.discord.token);
