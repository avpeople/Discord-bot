import { MessageFlags, PermissionsBitField } from 'discord.js';
import { setLogChannel } from './log-channel-store.js';

function canManage(interaction) {
  return interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

/**
 * Shared implementation for "set the log channel for <kind>" commands —
 * `/code set-log-channel` (kind: 'activity') and `/studio set-log-channel`
 * (kind: 'studio'). `label` is used in the confirmation message.
 */
async function handleSetLogChannelFor(interaction, kind, label) {
  if (!canManage(interaction)) {
    await interaction.reply({
      content: 'You need the **Manage Channels** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  setLogChannel(interaction.guildId, channel.id, kind);
  await interaction.reply({
    content: `✅ ${label} will now be logged in ${channel}.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** `/code set-log-channel` — designates a channel for Claude Code session activity logging. */
export function handleSetLogChannel(interaction) {
  return handleSetLogChannelFor(interaction, 'activity', 'Session activity');
}

/** `/studio set-log-channel` — designates a channel for studio/GFX monitoring events. */
export function handleSetStudioLogChannel(interaction) {
  return handleSetLogChannelFor(interaction, 'studio', 'Studio events');
}
