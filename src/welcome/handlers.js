import { MessageFlags, PermissionsBitField } from 'discord.js';
import { getGuildConfig, addRole, removeRole, setApprovalChannel } from './store.js';
import {
  buildWelcomeEmbed,
  buildWelcomePanelRows,
  buildApprovalRow,
  isRequestButton,
  isApproveButton,
  isDenyButton,
  roleIdFromRequestButton,
  decodeDecisionButton,
  APPROVE_PREFIX,
  DENY_PREFIX,
} from './components.js';

/** Only members who can manage roles may configure the welcome panel or approve/deny requests. */
function canManage(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageRoles) ?? false;
}

/**
 * Discord rejects role grants with a generic "Missing Access"/"Missing
 * Permissions" error in two situations that look identical from the error
 * message alone, so we check both directly and say which one it is:
 *   1. The bot's own highest role isn't positioned ABOVE the role being
 *      granted (Discord's role hierarchy rule — Manage Roles isn't enough).
 *   2. The bot itself lacks the Manage Roles permission in the guild.
 * Returns a human-readable reason string, or null if everything looks fine.
 */
function diagnoseRoleGrantProblem(guild, role) {
  const botMember = guild.members.me;
  if (!botMember) return "the bot's own member record couldn't be loaded.";
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return "the bot doesn't have the **Manage Roles** permission in this server.";
  }
  if (role.position >= botMember.roles.highest.position) {
    return (
      `the bot's highest role (**${botMember.roles.highest.name}**) is at or below **${role.name}** ` +
      `in Server Settings → Roles. Drag the bot's role above **${role.name}** and try again.`
    );
  }
  if (role.managed) {
    return `**${role.name}** is managed by an integration/bot and can't be assigned manually.`;
  }
  return null;
}

function replyNoPermission(interaction) {
  return interaction.reply({
    content: "You need the **Manage Roles** permission to do that.",
    flags: MessageFlags.Ephemeral,
  });
}

/** `/welcome add-role` */
export async function handleWelcomeAddRole(interaction) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);

  const role = interaction.options.getRole('role', true);
  const label = interaction.options.getString('label') || role.name;
  addRole(interaction.guildId, role.id, label);

  const problem = diagnoseRoleGrantProblem(interaction.guild, role);
  const warning = problem ? `\n\n⚠️ The bot can't actually grant this role yet: ${problem}` : '';

  await interaction.reply({
    content: `✅ Added **${label}** (${role}) to the welcome panel's requestable roles. Re-run \`/welcome post\` in a channel to update the panel there.${warning}`,
    flags: MessageFlags.Ephemeral,
  });
}

/** `/welcome remove-role` */
export async function handleWelcomeRemoveRole(interaction) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);

  const role = interaction.options.getRole('role', true);
  removeRole(interaction.guildId, role.id);

  await interaction.reply({
    content: `✅ Removed ${role} from the welcome panel's requestable roles. Re-run \`/welcome post\` to update an existing panel.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** `/welcome set-approval-channel` */
export async function handleWelcomeSetApprovalChannel(interaction) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);

  const channel = interaction.options.getChannel('channel', true);
  setApprovalChannel(interaction.guildId, channel.id);

  await interaction.reply({
    content: `✅ Role requests will now be posted in ${channel} for approval.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** `/welcome post` — posts the panel with one button per configured role into the given channel. */
export async function handleWelcomePost(interaction) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);

  const channel = interaction.options.getChannel('channel', true);
  const { roles, approvalChannelId } = getGuildConfig(interaction.guildId);

  if (roles.length === 0) {
    await interaction.reply({
      content: "No requestable roles configured yet — add some with `/welcome add-role` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!approvalChannelId) {
    await interaction.reply({
      content:
        "No approval channel set yet — run `/welcome set-approval-channel` first, so requests have somewhere to go.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = buildWelcomeEmbed({
    title: interaction.options.getString('title'),
    description: interaction.options.getString('description'),
    roles,
    guildName: interaction.guild.name,
    iconURL: interaction.guild.iconURL({ size: 256 }),
  });

  await channel.send({ embeds: [embed], components: buildWelcomePanelRows(roles) });
  await interaction.reply({ content: `✅ Posted the welcome panel in ${channel}.`, flags: MessageFlags.Ephemeral });
}

/** Click on a role-request button from the welcome panel. */
export async function handleRoleRequestButton(interaction) {
  const roleId = roleIdFromRequestButton(interaction.customId);
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.reply({
      content: "That role no longer exists — ask an admin to update the welcome panel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.member.roles.cache.has(roleId)) {
    await interaction.reply({ content: `You already have **${role.name}**.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const { approvalChannelId } = getGuildConfig(interaction.guildId);
  if (!approvalChannelId) {
    await interaction.reply({
      content: "Role requests aren't configured yet — ask an admin to set an approval channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const approvalChannel = await interaction.guild.channels.fetch(approvalChannelId).catch(() => null);
  if (!approvalChannel) {
    await interaction.reply({
      content: "The configured approval channel is missing — ask an admin to reset it.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await approvalChannel.send({
    content: `📝 ${interaction.user} requested the **${role.name}** role.`,
    components: [buildApprovalRow(role.id, interaction.user.id)],
  });

  await interaction.reply({
    content: `✅ Requested **${role.name}** — an admin will review it.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDecision({ interaction, approve }) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);

  const { roleId, userId } = decodeDecisionButton(interaction.customId, approve ? APPROVE_PREFIX : DENY_PREFIX);
  const role = interaction.guild.roles.cache.get(roleId);
  const member = await interaction.guild.members.fetch(userId).catch(() => null);

  if (!role || !member) {
    await interaction.update({
      content: `${interaction.message.content}\n\n⚠️ Couldn't ${approve ? 'approve' : 'deny'} — role or member no longer exists.`,
      components: [],
    });
    return;
  }

  if (approve) {
    try {
      await member.roles.add(role);
    } catch (err) {
      const problem = diagnoseRoleGrantProblem(interaction.guild, role);
      const detail = problem
        ? problem
        : `${err.message} (unclear cause — check the bot's permissions and role position in Server Settings → Roles)`;
      await interaction.update({
        content: `${interaction.message.content}\n\n❌ Failed to add the role: ${detail}`,
        components: [],
      });
      return;
    }
  }

  await interaction.update({
    content: `${interaction.message.content}\n\n${approve ? '✅ Approved' : '🚫 Denied'} by ${interaction.user}.`,
    components: [],
  });

  await member
    .send(
      approve
        ? `✅ Your request for the **${role.name}** role in **${interaction.guild.name}** was approved.`
        : `🚫 Your request for the **${role.name}** role in **${interaction.guild.name}** was denied.`,
    )
    .catch(() => {
      // Member has DMs closed — nothing more we can do, the approval channel record is enough.
    });
}

export async function handleApproveButton(interaction) {
  return handleDecision({ interaction, approve: true });
}

export async function handleDenyButton(interaction) {
  return handleDecision({ interaction, approve: false });
}

export { isRequestButton, isApproveButton, isDenyButton };
