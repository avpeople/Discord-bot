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
  handleApproveBashButton,
  handleDenyBashButton,
  REPO_SELECT_ID,
  COMMIT_BUTTON_ID,
  KEEP_GOING_BUTTON_ID,
  EXIT_BUTTON_ID,
  OPTION_BUTTON_PREFIX,
  CLOSE_PUSH_BUTTON_ID,
  CLOSE_EXIT_BUTTON_ID,
  APPROVE_BASH_BUTTON_ID,
  DENY_BASH_BUTTON_ID,
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const sessionManager = new SessionManager();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  initLogChannel(client);
  startNotifyServer();

  const restored = sessionManager.restore();
  if (restored.length > 0) {
    console.log(`Restored ${restored.length} session(s) from disk.`);
  }
  for (const session of restored) {
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (channel) {
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

    if (interaction.isButton() && interaction.customId === APPROVE_BASH_BUTTON_ID) {
      return handleApproveBashButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === DENY_BASH_BUTTON_ID) {
      return handleDenyBashButton(interaction, sessionManager);
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
