import { MessageFlags, PermissionsBitField, ChannelType } from 'discord.js';
import { config } from '../config.js';
import { isConfigured, createPairing, leavePairing, getPairing } from './bridge-client.js';

/** Same admin bar as the welcome panel — this is infra-level, not Claude-session access. */
function canManage(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

function replyNoPermission(interaction) {
  return interaction.reply({
    content: 'You need the **Manage Channels** permission to do that.',
    flags: MessageFlags.Ephemeral,
  });
}

function replyNotConfigured(interaction) {
  return interaction.reply({
    content:
      "The voice bridge isn't configured on this bot (`BRIDGE_DISCORD_URL` is unset) — see the Coms server repo's `bridge-discord/README.md` to deploy it first.",
    flags: MessageFlags.Ephemeral,
  });
}

/** `/voice join` */
export async function handleVoiceJoin(interaction) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);
  if (!isConfigured()) return replyNotConfigured(interaction);

  const liveKitChannelId = interaction.options.getString('room', true);
  const voiceChannel = interaction.options.getChannel('channel', true);

  if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
    await interaction.reply({
      content: `${voiceChannel} isn't a voice channel.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  // Discord voice channel id doubles as the pairing id — stable, unique,
  // and means a second /voice join in the same channel naturally targets
  // the same pairing rather than needing our own id bookkeeping.
  const pairingId = voiceChannel.id;

  try {
    const existing = await getPairing(pairingId);
    if (existing) {
      await interaction.editReply(
        `⚠️ ${voiceChannel} is already bridged to LiveKit channel \`${existing.liveKitChannelId}\`. Run \`/voice leave\` there first if you want to re-pair it.`,
      );
      return;
    }

    await createPairing({
      id: pairingId,
      liveKitChannelId,
      discordGuildId: interaction.guildId,
      discordVoiceChannelId: voiceChannel.id,
    });

    await interaction.editReply(
      `✅ Bridged ${voiceChannel} to LiveKit channel \`${liveKitChannelId}\`. Run \`/voice leave channel:${voiceChannel.name}\` to disconnect it.`,
    );
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't start the bridge: ${err.message}`.slice(0, 2000));
  }
}

/** `/voice leave` */
export async function handleVoiceLeave(interaction) {
  if (!canManage(interaction.member)) return replyNoPermission(interaction);
  if (!isConfigured()) return replyNotConfigured(interaction);

  const voiceChannel = interaction.options.getChannel('channel', true);
  await interaction.deferReply();

  try {
    const left = await leavePairing(voiceChannel.id);
    await interaction.editReply(
      left ? `✅ Disconnected ${voiceChannel} from the voice bridge.` : `${voiceChannel} wasn't bridged.`,
    );
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't stop the bridge: ${err.message}`.slice(0, 2000));
  }
}

/** `/voice status` */
export async function handleVoiceStatus(interaction) {
  if (!isConfigured()) return replyNotConfigured(interaction);

  const voiceChannel = interaction.options.getChannel('channel', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const status = await getPairing(voiceChannel.id);
    if (!status) {
      await interaction.editReply(`${voiceChannel} isn't bridged.`);
      return;
    }
    await interaction.editReply(
      `**${voiceChannel.name}** ↔ LiveKit \`${status.liveKitChannelId}\`\n` +
        `LiveKit connected: ${status.liveKitConnected ? '✅' : '❌'}\n` +
        `Discord connected: ${status.discordConnected ? '✅' : '❌'}\n` +
        `Started: <t:${Math.floor(new Date(status.startedAt).getTime() / 1000)}:R>`,
    );
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't get status: ${err.message}`.slice(0, 2000));
  }
}
