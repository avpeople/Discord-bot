import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { signalEmoji } from './signal-emojis.js';

/**
 * Renders the LiveU status channel: a summary message at the top
 * ("2 live · 1 online · 5 offline") and one message per online unit with its details and Go Live / Stop buttons.
 */

export const GO_LIVE_PREFIX = 'liveu:go-live:';
export const STOP_PREFIX = 'liveu:stop:';
export const MTX_SELECT_PREFIX = 'liveu:mtx:';
// The dropdown's "type a stream name" entry, for a stream that isn't live yet.
export const MTX_OTHER_VALUE = '__other__';

const STATE_STYLE = {
  live: { icon: '🔴', label: 'LIVE', color: 0xed4245 },
  online: { icon: '🟢', label: 'Online', color: 0x57f287 },
  offline: { icon: '⚫', label: 'Offline', color: 0x4f545c },
};

export function formatBitrate(kbps) {
  if (kbps === null || kbps === undefined) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function simLine(sim) {
  const down = sim.connected === false;
  // Custom signal-bar emoji (0–5 lit, or all red when down); plain icons + text if they aren't uploaded.
  const custom = signalEmoji(down ? 'down' : sim.signal);
  const icon = custom ?? (down ? '❌' : sim.connected ? '📶' : '❔');
  const parts = [
    down ? 'down' : formatBitrate(sim.kbps),
    sim.carrier,
    sim.technology,
    !custom && !down && sim.signal !== null ? `signal ${Math.max(0, Math.min(5, Math.round(sim.signal)))}/5` : null,
  ].filter(Boolean);
  return `${icon} **${sim.name}** · ${parts.join(' · ')}`;
}

const HOP_SHORT = { 'camera-server': 'Cam', 'server-studio': 'Studio' };

function hopText(hop) {
  if (!hop) return '—';
  if (hop.status === 'offline') return '🔴';
  if (hop.status === 'warning') return `🟡 ${hop.bitrateMbps !== null ? `${hop.bitrateMbps.toFixed(2)} Mbps` : 'low'}`;
  return '🟢';
}

/**
 * The MediaMTX panel (its own channel): the media-mtx site's streams, live
 * or not, and each hop's status (🟢 ok, 🟡 low bitrate, 🔴 offline).
 */
export function buildMediamtxMessage(mtx) {
  const live = mtx.paths.filter((p) => p.live).length;
  const lines = [
    `## 🟢 ${live} live stream${live === 1 ? '' : 's'}`,
    `-# ${mtx.srtAddress ? `${mtx.srtAddress} · ` : ''}updated <t:${Math.floor(Date.now() / 1000)}:R>`,
  ];
  for (const p of mtx.paths) {
    const hops = Object.entries(p.hops)
      .map(([hop, status]) => `${HOP_SHORT[hop] ?? hop} ${hopText(status)}`)
      .join(' · ');
    lines.push(`${p.live ? '🟢' : '⚫'} **${p.path}** · ${hops}`);
  }
  if (mtx.paths.length === 0) lines.push('-# No streams right now.');
  if (mtx.error) lines.push(`⚠️ ${mtx.error.slice(0, 300)}`);

  let description = lines.join('\n');
  if (description.length > 4000) description = `${description.slice(0, 3990)}\n…`;
  const embed = new EmbedBuilder()
    .setTitle('MediaMTX')
    .setDescription(description)
    .setColor(mtx.error ? 0xfee75c : live ? 0x57f287 : 0x4f545c);
  return { content: '', embeds: [embed], components: [] };
}

export function buildSummaryMessage(snapshots, error) {
  const count = (state) => snapshots.filter((s) => s.state === state).length;
  const live = count('live');
  const online = count('online');
  const offline = count('offline');

  const lines = [
    `## 🔴 ${live} live   🟢 ${online} online   ⚫ ${offline} offline`,
    `-# ${snapshots.length} unit${snapshots.length === 1 ? '' : 's'} · updated <t:${Math.floor(Date.now() / 1000)}:R>`,
  ];
  if (error) lines.push(`⚠️ Can't reach LiveU right now: ${error.slice(0, 300)}`);

  const embed = new EmbedBuilder()
    .setTitle('LiveU Status')
    .setDescription(lines.join('\n'))
    .setColor(error ? 0xfee75c : live ? STATE_STYLE.live.color : online ? STATE_STYLE.online.color : STATE_STYLE.offline.color);
  return { content: '', embeds: [embed], components: [] };
}

/**
 * "Set destination → MediaMTX stream" dropdown: the site's live streams
 * first, then other streams it has seen recently, then "Other…" to type a
 * name. The unit's current destination shows as selected. Only offered
 * when the site login (which gives the SRT address) is configured.
 */
function buildMtxSelectRow(snap, mtx) {
  if (!mtx?.srtAddress) return null;
  const names = [...mtx.paths.filter((p) => p.live), ...mtx.paths.filter((p) => !p.live)].map((p) => p.path);
  const options = names.slice(0, 24).map((path) => ({
    label: path.slice(0, 100),
    value: path.slice(0, 100),
    emoji: mtx.streams.includes(path) ? '🟢' : '⚫',
    default: snap.destination === path,
  }));
  options.push({ label: 'Other… (type a stream name)', value: MTX_OTHER_VALUE, emoji: '✏️' });

  const live = snap.state === 'live';
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${MTX_SELECT_PREFIX}${snap.id}`)
      .setPlaceholder(live ? 'Stop the stream to change its MediaMTX destination' : 'Set destination → MediaMTX stream...')
      .setDisabled(live)
      .addOptions(options),
  );
}

export function buildUnitMessage(snap, mtx = null) {
  const style = STATE_STYLE[snap.state];
  const embed = new EmbedBuilder()
    .setTitle(`${style.icon} ${snap.name}`)
    .setColor(style.color)
    .setFooter({ text: [snap.product, snap.serial, snap.swVersion && `SW ${snap.swVersion}`].filter(Boolean).join(' · ') || snap.id });

  const status = [`**${style.label}**`];
  if (snap.destination) status.push(snap.state === 'live' ? `to **${snap.destination}**` : `· Go Live → **${snap.destination}**`);
  const uptime = snap.state === 'live' ? formatUptime(snap.video.uptimeSec) : null;
  if (uptime) status.push(`for ${uptime}`);
  embed.setDescription(status.join(' '));

  if (snap.state !== 'offline') {
    const input =
      snap.video.inputConnected === false
        ? '❌ No input'
        : snap.video.inputConnected
          ? `✅ ${[snap.video.resolution, snap.video.fps && `${snap.video.fps}fps`].filter(Boolean).join(' ') || 'Connected'}`
          : '—';
    const upSims = snap.sims.filter((s) => s.connected !== false).length;

    embed.addFields(
      { name: 'Bitrate', value: formatBitrate(snap.totalKbps), inline: true },
      { name: 'Input', value: input, inline: true },
      { name: 'SIMs', value: snap.sims.length ? `${upSims} / ${snap.sims.length} up` : '—', inline: true },
    );
    if (snap.battery !== null) {
      embed.addFields({ name: 'Battery', value: `${snap.charging ? '🔌' : '🔋'} ${Math.round(snap.battery)}%`, inline: true });
    }

    const links = snap.interfaces.map(simLine);
    if (links.length) embed.addFields({ name: 'Connections', value: links.join('\n').slice(0, 1024) });
    if (!snap.detailsOk) embed.addFields({ name: '\u200b', value: '-# Live details unavailable right now.' });
  }

  const row = new ActionRowBuilder().addComponents(
    snap.state === 'live'
      ? new ButtonBuilder().setCustomId(`${STOP_PREFIX}${snap.id}`).setLabel('Stop Stream').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      : new ButtonBuilder()
          .setCustomId(`${GO_LIVE_PREFIX}${snap.id}`)
          .setLabel('Go Live')
          .setEmoji('🔴')
          .setStyle(ButtonStyle.Success)
          .setDisabled(snap.state === 'offline'),
  );

  const mtxRow = snap.state === 'offline' ? null : buildMtxSelectRow(snap, mtx);
  return { content: '', embeds: [embed], components: mtxRow ? [row, mtxRow] : [row] };
}

/** Comparable form of a rendered message, minus the summary's always-changing "updated" time. */
export function messageKey(payload) {
  return JSON.stringify({
    embeds: payload.embeds.map((e) => {
      const data = e.toJSON();
      return { ...data, description: data.description?.replace(/<t:\d+:R>/g, '') };
    }),
    components: payload.components.map((c) => c.toJSON()),
  });
}
