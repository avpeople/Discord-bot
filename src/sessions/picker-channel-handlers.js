import { MessageFlags, PermissionsBitField } from 'discord.js';
import { buildRepoPickerReply, PERSISTENT_REPO_SELECT_ID } from './repo-picker.js';
import { getPickerChannel, setPickerChannel } from './picker-channel-store.js';
import { hasAccess, createSessionForRepo } from './handlers.js';
import { buildOpenSessionRow } from './reply.js';

const CONFIRMATION_VISIBLE_MS = 10_000;
// How often the picker message is re-rendered to update the usage bars.
const USAGE_REFRESH_MS = 3 * 60 * 1000;

// Picker messages currently showing a "session started" confirmation — the
// usage refresh leaves these alone so it doesn't cut the confirmation short.
const confirmingMessageIds = new Set();

/** Only members who can manage channels may designate the picker channel — this is server config, not a per-session action. */
function canManage(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

/** `/code set-picker-channel` — designates a channel to always show the repo picker. */
export async function handleSetPickerChannel(interaction) {
  if (!canManage(interaction.member)) {
    await interaction.reply({
      content: 'You need the **Manage Channels** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const reply = await buildRepoPickerReply(PERSISTENT_REPO_SELECT_ID);
    const message = await channel.send(reply);
    setPickerChannel(interaction.guildId, channel.id, message.id);
    await interaction.editReply(`✅ ${channel} now always shows the repo picker.`);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't set up the picker channel: ${err.message}`.slice(0, 2000));
  }
}

/**
 * Repo picked from the persistent picker channel's select menu. Creates
 * the session the same way `/code new` does, then shows a temporary
 * confirmation in the picker channel itself (per the user's request — not
 * ephemeral, so anyone watching the channel sees it happened) before
 * reverting that message back to the plain picker after ~10s.
 */
export async function handlePersistentRepoSelected(interaction, sessionManager) {
  if (!hasAccess(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  const fullName = interaction.values[0];
  const pickerMessage = interaction.message;

  let sessionChannel;
  try {
    sessionChannel = await createSessionForRepo({
      guild: interaction.guild,
      user: interaction.user,
      fullName,
      sessionManager,
    });
  } catch (err) {
    console.error(err);
    await pickerMessage
      .edit({ content: `❌ Couldn't start a session for \`${fullName}\`: ${err.message}`.slice(0, 2000), components: [] })
      .catch(() => {});
    await resetToPicker(pickerMessage);
    return;
  }

  confirmingMessageIds.add(pickerMessage.id);
  await pickerMessage.edit({
    content: `✅ ${interaction.user} started a session for **${fullName}**: ${sessionChannel}`,
    components: [buildOpenSessionRow(interaction.guildId, sessionChannel.id)],
  });

  setTimeout(() => {
    confirmingMessageIds.delete(pickerMessage.id);
    resetToPicker(pickerMessage).catch((err) => console.error('Failed to reset picker channel message:', err));
  }, CONFIRMATION_VISIBLE_MS);
}

async function resetToPicker(message) {
  const reply = await buildRepoPickerReply(PERSISTENT_REPO_SELECT_ID);
  await message.edit(reply);
}

/**
 * Called once on boot per restored guild config, so the picker message
 * reflects the current repo list and select menu even if the bot restarted
 * mid-confirmation-window. Re-fetches the message by id rather than
 * re-posting, so the channel never ends up with two picker messages.
 */
export async function resyncPickerChannel(client, guildId) {
  const entry = getPickerChannel(guildId);
  if (!entry) return;

  const channel = await client.channels.fetch(entry.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(entry.messageId).catch(() => null);
  if (!message) return;

  await resetToPicker(message).catch((err) => console.error('Failed to resync picker channel on boot:', err));
}

/**
 * Re-renders each guild's picker message every few minutes so its Claude
 * usage bars stay current. Skips the edit when nothing changed (reset times
 * are Discord timestamps, so they count down without edits).
 */
export function startPickerUsageRefresh(client) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const entry = getPickerChannel(guild.id);
      if (!entry || confirmingMessageIds.has(entry.messageId)) continue;
      try {
        const channel = await client.channels.fetch(entry.channelId).catch(() => null);
        const message = await channel?.messages.fetch(entry.messageId).catch(() => null);
        if (!message) continue;
        const reply = await buildRepoPickerReply(PERSISTENT_REPO_SELECT_ID);
        if (reply.content === message.content || confirmingMessageIds.has(message.id)) continue;
        await message.edit(reply);
      } catch (err) {
        console.error('Failed to refresh picker usage:', err);
      }
    }
  }, USAGE_REFRESH_MS);
}
