import { MessageFlags, PermissionsBitField } from 'discord.js';
import { setLogChannel } from './log-channel-store.js';

/** `/code set-log-channel` — designates a channel for session activity logging. */
export async function handleSetLogChannel(interaction) {
  const canManage = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
  if (!canManage) {
    await interaction.reply({
      content: 'You need the **Manage Channels** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  setLogChannel(interaction.guildId, channel.id);
  await interaction.reply({
    content: `✅ Session activity will now be logged in ${channel}.`,
    flags: MessageFlags.Ephemeral,
  });
}
