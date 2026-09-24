import { ChannelType, PermissionsBitField } from 'discord.js';

const CATEGORY_NAME = 'Claude Sessions';

/** Finds (or creates) the category all session channels live under. */
async function ensureCategory(guild) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME,
  );
  if (existing) return existing;
  return guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
  });
}

/**
 * Creates a private text channel under the Claude Sessions category,
 * visible only to the invoking user, the allowed role, and the bot itself.
 */
export async function createSessionChannel({ guild, ownerId, allowedRoleId, repoFullName, sessionId }) {
  const category = await ensureCategory(guild);
  const safeName = repoFullName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

  const channel = await guild.channels.create({
    name: `claude-${safeName}-${sessionId}`,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: allowedRoleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      },
      {
        id: ownerId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      },
      {
        id: guild.members.me.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
    ],
  });

  return channel;
}
