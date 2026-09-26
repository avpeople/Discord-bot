import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import * as liveu from './client.js';
import { unitState } from './parse.js';
import { getLiveuConfig, updateLiveuConfig } from './store.js';
import { isMonitoring, latestSnapshots, pollNow, renderPanel } from './monitor.js';
import { formatBitrate, GO_LIVE_PREFIX, MTX_OTHER_VALUE, MTX_SELECT_PREFIX, STOP_PREFIX } from './view.js';
import { logEvent } from '../log-channel.js';
import * as mtx from '../mediamtx/client.js';

const GO_LIVE_CONFIRM_PREFIX = 'liveu:go-live-confirm:';
const STOP_CONFIRM_PREFIX = 'liveu:stop-confirm:';
const MTX_MODAL_PREFIX = 'liveu:mtx-modal:';
const MTX_PATH_INPUT_ID = 'path';
// MediaMTX path names: letters, digits and a few separators.
const MTX_PATH_PATTERN = /^[A-Za-z0-9._~\-/]+$/;

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

/** `/studio set-mediamtx-channel` — gives the MediaMTX stream panel its own channel. */
export async function handleSetMediamtxChannel(interaction) {
  if (!canManage(interaction)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  if (!isMonitoring() || (!mtx.isConfigured() && !mtx.eventsConfigured() && !mtx.apiConfigured())) {
    return interaction.reply(
      ephemeral("The media-mtx site isn't set up on the bot — set `MEDIAMTX_URL` + `MEDIAMTX_USERNAME` / `MEDIAMTX_PASSWORD` (and `MEDIAMTX_EVENTS_API_KEY` for stream status) and redeploy."),
    );
  }

  const channel = interaction.options.getChannel('channel', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Moving the panel: remove the old one so it doesn't sit there frozen.
  const old = getLiveuConfig(interaction.guildId);
  if (old?.mtxChannelId && old.mtxMessageId) {
    const oldChannel = await interaction.client.channels.fetch(old.mtxChannelId).catch(() => null);
    await oldChannel?.messages.delete(old.mtxMessageId).catch(() => {});
  }

  updateLiveuConfig(interaction.guildId, { mtxChannelId: channel.id, mtxMessageId: null });
  await pollNow();
  await renderPanel(interaction.guildId, latestSnapshots());
  await interaction.editReply(`✅ ${channel} now shows the MediaMTX streams. Stream events go to the studio log.`);
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
      status: await settle(liveu.getStatus(unit.BOSSID)),
      stream: await settle(liveu.getStream(unit.BOSSID)),
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

/**
 * Go Live on a unit's box: confirm first, naming where it'll stream to —
 * LiveU streams to the unit's currently selected destination.
 */
async function handleGoLiveButton(interaction, bossId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const stream = await liveu.getStream(bossId).catch(() => null);
  const destination = stream?.destinationName ?? latestSnapshots().find((s) => s.id === bossId)?.destination;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${GO_LIVE_CONFIRM_PREFIX}${bossId}`).setLabel('Yes, go live').setEmoji('🔴').setStyle(ButtonStyle.Success),
  );
  await interaction.editReply({
    content: `🔴 Go live on **${unitName(bossId)}**${destination ? ` → **${destination}**` : ' (to its selected destination)'}?`,
    components: [row],
  });
}

async function handleGoLiveConfirm(interaction, bossId) {
  await interaction.update({ content: `⏳ Starting **${unitName(bossId)}**...`, components: [] });
  try {
    await liveu.startStream(bossId);
    await interaction.editReply(`✅ Go Live sent to **${unitName(bossId)}**. The board updates when LiveU reports it live.`);
    await logEvent(interaction.guildId, `▶️ ${interaction.user} pressed **Go Live** on **${unitName(bossId)}**`, 'studio');
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

/**
 * Points a unit at a MediaMTX stream: an SRT destination publishing into
 * `path` on the media-mtx site's SRT address, selected as the unit's
 * destination — so the next Go Live streams there.
 */
async function applyMtxDestination(interaction, bossId, path) {
  const name = unitName(bossId);
  if (latestSnapshots().find((s) => s.id === bossId)?.state === 'live') {
    return interaction.editReply(`**${name}** is live — stop the stream before changing its destination.`);
  }
  try {
    const { srtAddress } = await mtx.getStreams();
    if (!srtAddress) throw new Error("the media-mtx site didn't return an SRT address");
    await liveu.setSrtDestination(bossId, { title: path, url: srtAddress, streamId: mtx.publishStreamId(path) });
    await interaction.editReply(`✅ **${name}** now streams to MediaMTX **${path}** on Go Live.`);
    await logEvent(interaction.guildId, `🎯 ${interaction.user} set **${name}**'s destination to MediaMTX **${path}**`, 'studio');
  } catch (err) {
    await interaction.editReply(`❌ Couldn't set the destination: ${err.message}`.slice(0, 2000));
    return;
  }
  setTimeout(() => pollNow(), 2000);
}

async function handleMtxSelect(interaction, bossId) {
  const path = interaction.values[0];
  if (path === MTX_OTHER_VALUE) {
    const modal = new ModalBuilder()
      .setCustomId(`${MTX_MODAL_PREFIX}${bossId}`)
      .setTitle(`MediaMTX stream for ${unitName(bossId)}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(MTX_PATH_INPUT_ID)
            .setLabel('Stream name')
            .setPlaceholder('e.g. LU300-1')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100),
        ),
      );
    return interaction.showModal(modal);
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return applyMtxDestination(interaction, bossId, path);
}

async function handleMtxModal(interaction, bossId) {
  const path = interaction.fields.getTextInputValue(MTX_PATH_INPUT_ID).trim();
  if (!MTX_PATH_PATTERN.test(path)) {
    return interaction.reply(ephemeral('Stream names can only use letters, numbers and `. _ ~ - /`.'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return applyMtxDestination(interaction, bossId, path);
}

/** Routes every `liveu:*` button, select menu and modal. */
export async function handleLiveuInteraction(interaction) {
  if (!canOperate(interaction)) return interaction.reply(ephemeral("You don't have permission to control the LiveUs."));
  const id = interaction.customId;
  if (id.startsWith(GO_LIVE_CONFIRM_PREFIX)) return handleGoLiveConfirm(interaction, id.slice(GO_LIVE_CONFIRM_PREFIX.length));
  if (id.startsWith(GO_LIVE_PREFIX)) return handleGoLiveButton(interaction, id.slice(GO_LIVE_PREFIX.length));
  if (id.startsWith(STOP_CONFIRM_PREFIX)) return handleStopConfirm(interaction, id.slice(STOP_CONFIRM_PREFIX.length));
  if (id.startsWith(STOP_PREFIX)) return handleStopButton(interaction, id.slice(STOP_PREFIX.length));
  if (id.startsWith(MTX_SELECT_PREFIX)) return handleMtxSelect(interaction, id.slice(MTX_SELECT_PREFIX.length));
  if (id.startsWith(MTX_MODAL_PREFIX)) return handleMtxModal(interaction, id.slice(MTX_MODAL_PREFIX.length));
}
