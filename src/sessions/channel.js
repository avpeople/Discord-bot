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
 * Named `claude-<owner>-<repo>` (e.g. claude-avpeople-live-nz); a second
 * open session on the same repo gets `-2`, then `-3`, and so on. Sessions
 * are tracked by channel id, so the name is purely for people.
 */
export async function createSessionChannel({ guild, ownerId, allowedRoleId, repoFullName }) {
  const category = await ensureCategory(guild);
  const baseName = `claude-${repoFullName.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase()}`;
  const taken = new Set(guild.channels.cache.filter((c) => c.parentId === category.id).map((c) => c.name));
  let name = baseName;
  for (let n = 2; taken.has(name); n += 1) name = `${baseName}-${n}`;

  const channel = await guild.channels.create({
    name,
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
