import { Client, GatewayIntentBits, Partials, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { SessionManager } from './sessions/manager.js';
import {
  hasAccess,
  handleCodeNew,
  handleCodeClose,
  handleRepoSelected,
  handleSessionMessage,
  handlePushButton,
  handleKeepGoingButton,
  REPO_SELECT_ID,
  PUSH_BUTTON_ID,
  KEEP_GOING_BUTTON_ID,
} from './sessions/handlers.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const sessionManager = new SessionManager();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

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
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'code') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'new') return handleCodeNew(interaction);
      if (sub === 'close') return handleCodeClose(interaction, sessionManager);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === REPO_SELECT_ID) {
      return handleRepoSelected(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === PUSH_BUTTON_ID) {
      return handlePushButton(interaction, sessionManager);
    }

    if (interaction.isButton() && interaction.customId === KEEP_GOING_BUTTON_ID) {
      return handleKeepGoingButton(interaction);
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
