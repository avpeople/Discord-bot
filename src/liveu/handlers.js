import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config } from '../config.js';
import * as liveu from './client.js';
import { unitState } from './parse.js';
import { getLiveuConfig, updateLiveuConfig } from './store.js';
import { isMonitoring, latestSnapshots, pollNow, renderPanel } from './monitor.js';
import { formatBitrate, GO_LIVE_PREFIX, STOP_PREFIX } from './view.js';
import { logEvent } from '../log-channel.js';

const START_SELECT_PREFIX = 'liveu:start:';
const STOP_CONFIRM_PREFIX = 'liveu:stop-confirm:';

export function isLiveuInteraction(customId) {
  return customId.startsWith('liveu:');
}

function canManage(interaction) {
  return interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

/** Who may press Go Live / Stop: LIVEU_ROLE_ID if set, otherwise the bot's ALLOWED_ROLE_ID. */
function canOperate(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  const roleId = config.liveu.roleId;
  return roles.cache ? roles.cache.has(roleId) : roles.includes?.(roleId);
}

const ephemeral = (content, extra = {}) => ({ content: content.slice(0, 2000), flags: MessageFlags.Ephemeral, ...extra });

function unitName(bossId) {
  return latestSnapshots().find((s) => s.id === bossId)?.name ?? bossId;
}

/** `/studio set-liveu-channel` — makes a channel the live LiveU status board. */
export async function handleSetLiveuChannel(interaction) {
  if (!canManage(interaction)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  if (!isMonitoring()) {
    return interaction.reply(ephemeral('LiveU isn\'t set up on the bot — set `LIVEU_EMAIL` and `LIVEU_PASSWORD` and redeploy.'));
  }

  const channel = interaction.options.getChannel('channel', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Moving the board: clear the old one so it doesn't sit there frozen.
  const old = getLiveuConfig(interaction.guildId);
  if (old?.channelId) {
    const oldChannel = await interaction.client.channels.fetch(old.channelId).catch(() => null);
    for (const messageId of [old.summaryMessageId, ...Object.values(old.unitMessages ?? {})]) {
      if (!messageId || !oldChannel) continue;
      await oldChannel.messages.delete(messageId).catch(() => {});
    }
  }

  updateLiveuConfig(interaction.guildId, { channelId: channel.id, summaryMessageId: null, unitMessages: {} });
  await pollNow();
  await renderPanel(interaction.guildId, latestSnapshots());
  await interaction.editReply(`✅ ${channel} now shows live LiveU status. Changes are logged to the studio log (\`/studio set-log-channel\`).`);
}

/** `/studio liveu-alert-bitrate` — the studio-log low-bitrate threshold (0 turns the alert off). */
export async function handleLiveuAlertBitrate(interaction) {
  if (!canManage(interaction)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  const kbps = interaction.options.getInteger('kbps', true);
  updateLiveuConfig(interaction.guildId, { lowBitrateKbps: kbps });
  return interaction.reply(
    ephemeral(kbps ? `✅ Live units under **${formatBitrate(kbps)}** will be logged as low bitrate.` : '✅ Low-bitrate alerts turned off.'),
  );
}

/**
 * `/studio liveu-raw` — the unprocessed API responses for one unit, as a
 * JSON file. For checking what the (undocumented) LiveU API actually
 * returns when a field on the board looks wrong.
 */
export async function handleLiveuRaw(interaction) {
  if (!canOperate(interaction)) return interaction.reply(ephemeral("You don't have permission to use this."));
  if (!liveu.isConfigured()) return interaction.reply(ephemeral('LiveU isn\'t set up on the bot.'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const query = interaction.options.getString('unit', true).trim().toLowerCase();
  try {
    const units = await liveu.listUnits();
    const unit = units.find((u) =>
      [u.name, u.device_name, u.SN, u.BOSSID].some((v) => v && String(v).toLowerCase() === query),
    ) ?? units.find((u) => String(u.name ?? '').toLowerCase().includes(query));
    if (!unit) {
      const names = units.map((u) => u.name || u.SN).join(', ');
      return interaction.editReply(`No unit matching \`${query}\`. Units: ${names || 'none'}`.slice(0, 2000));
    }

    const settle = (p) => p.then((value) => value, (err) => ({ error: err.message }));
    const raw = {
      unit,
      interfaces: await settle(liveu.getInterfaces(unit.BOSSID)),
      video: await settle(liveu.getVideo(unit.BOSSID)),
      destinations: await settle(liveu.getDestinations(unit.BOSSID)),
    };
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(raw, null, 2)), { name: `liveu-${unit.SN ?? unit.BOSSID}.json` });
    await interaction.editReply({
      content: `Raw API responses for **${unit.name}** (${unitState(unit)}). Interfaces/video only answer while the unit is online.`,
      files: [file],
    });
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`.slice(0, 2000));
  }
}

/** Go Live on a unit's box: pick which stream preset to go live to. Picking one is the confirmation. */
async function handleGoLiveButton(interaction, bossId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const presets = await liveu.getDestinations(bossId).catch((err) => err);
  if (presets instanceof Error) return interaction.editReply(`❌ Couldn't load stream presets: ${presets.message}`.slice(0, 2000));
  const usable = presets.filter((d) => liveu.destinationId(d)).slice(0, 25);
  if (usable.length === 0) {
    return interaction.editReply(`**${unitName(bossId)}** has no stream presets — add one in the LiveU Solo portal first.`);
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${START_SELECT_PREFIX}${bossId}`)
    .setPlaceholder('Choose where to go live...')
    .addOptions(
      usable.map((d) => ({
        label: String(d.title || 'Untitled preset').slice(0, 100),
        description: String(d.streaming_profile || d.streaming_provider || '').slice(0, 100) || undefined,
        value: liveu.destinationId(d),
      })),
    );
  await interaction.editReply({
    content: `🔴 Go live on **${unitName(bossId)}** — choosing a preset starts the stream.`,
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleStartSelect(interaction, bossId) {
  const destId = interaction.values[0];
  await interaction.update({ content: `⏳ Starting **${unitName(bossId)}**...`, components: [] });
  try {
    const presets = await liveu.getDestinations(bossId);
    const preset = presets.find((d) => liveu.destinationId(d) === destId);
    await liveu.startStream(bossId, preset ?? { id: destId });
    const title = preset?.title ?? 'preset';
    await interaction.editReply(`✅ Go Live sent to **${unitName(bossId)}** → **${title}**. The board updates when LiveU reports it live.`);
    await logEvent(interaction.guildId, `▶️ ${interaction.user} pressed **Go Live** on **${unitName(bossId)}** → **${title}**`, 'studio');
  } catch (err) {
    await interaction.editReply(`❌ Couldn't start the stream: ${err.message}`.slice(0, 2000));
    return;
  }
  setTimeout(() => pollNow(), 3000);
}

/** Stop on a live unit's box: asks for confirmation first — this ends a live broadcast. */
function handleStopButton(interaction, bossId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${STOP_CONFIRM_PREFIX}${bossId}`).setLabel('Yes, stop the stream').setStyle(ButtonStyle.Danger),
  );
  return interaction.reply(ephemeral(`⏹️ Stop **${unitName(bossId)}**? This ends the live stream.`, { components: [row] }));
}

async function handleStopConfirm(interaction, bossId) {
  await interaction.update({ content: `⏳ Stopping **${unitName(bossId)}**...`, components: [] });
  try {
    await liveu.stopStream(bossId);
    await interaction.editReply(`✅ Stop sent to **${unitName(bossId)}**.`);
    await logEvent(interaction.guildId, `⏹️ ${interaction.user} pressed **Stop** on **${unitName(bossId)}**`, 'studio');
  } catch (err) {
    await interaction.editReply(`❌ Couldn't stop the stream: ${err.message}`.slice(0, 2000));
    return;
  }
  setTimeout(() => pollNow(), 3000);
}

/** Routes every `liveu:*` button and select menu. */
export async function handleLiveuInteraction(interaction) {
  if (!canOperate(interaction)) return interaction.reply(ephemeral("You don't have permission to control the LiveUs."));
  const id = interaction.customId;
  if (id.startsWith(GO_LIVE_PREFIX)) return handleGoLiveButton(interaction, id.slice(GO_LIVE_PREFIX.length));
  if (id.startsWith(START_SELECT_PREFIX)) return handleStartSelect(interaction, id.slice(START_SELECT_PREFIX.length));
  if (id.startsWith(STOP_CONFIRM_PREFIX)) return handleStopConfirm(interaction, id.slice(STOP_CONFIRM_PREFIX.length));
  if (id.startsWith(STOP_PREFIX)) return handleStopButton(interaction, id.slice(STOP_PREFIX.length));
}
