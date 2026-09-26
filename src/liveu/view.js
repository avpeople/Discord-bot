import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
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

const HOP_SHORT = { 'camera-server': 'cam', 'server-studio': 'studio' };

const NAME_WIDTH_MAX = 18;
const TABLE_MAX_CHARS = 3600; // leaves room for the header lines in the 4096-char description

/**
 * The MediaMTX panel (its own channel): one row per stream in a monospace
 * table so the columns line up — a status dot (🟢 live, 🟡 low bitrate,
 * ⚫ offline), the name, IN (a feed publishing to it), OUT (the studio
 * pulling it), and the bitrate note when low. Only the leading dot is an emoji, so the text columns
 * stay aligned. Live streams first, then offline.
 *
 * The site's live list is the current truth for "is it live" — the events
 * feed only says when a hop last changed, so an old camera "offline" event
 * on a stream that's live now is stale and ignored. Hop events only count
 * for streams that are live.
 */
export function buildMediamtxMessage(mtx) {
  const ordered = [...mtx.paths.filter((p) => p.live), ...mtx.paths.filter((p) => !p.live)];
  const nameWidth = Math.min(NAME_WIDTH_MAX, Math.max(6, ...ordered.map((p) => p.path.length)));
  const pad = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

  let studioCount = 0;
  let lowCount = 0;
  // IN: a feed is publishing into the stream. OUT: the studio is pulling it (server → studio hop).
  const rows = ordered.map((p) => {
    if (!p.live) return `⚫ ${pad(p.path, nameWidth)}  ${pad('—', 6)}${pad('—', 10)}offline`;
    const warnings = Object.entries(p.hops).filter(([, h]) => h?.status === 'warning');
    const studio = p.hops['server-studio']?.status;
    const toStudio = studio === 'online' || studio === 'warning';
    if (toStudio) studioCount++;
    if (warnings.length) lowCount++;
    const note = warnings
      .map(([hop, h]) => `low${h.bitrateMbps !== null ? ` ${h.bitrateMbps.toFixed(2)} Mbps` : ''} (${HOP_SHORT[hop] ?? hop})`)
      .join(', ');
    return `${warnings.length ? '🟡' : '🟢'} ${pad(p.path, nameWidth)}  ${pad('▶ in', 6)}${pad(toStudio ? '▶ studio' : '—', 10)}${note}`.trimEnd();
  });

  let table = `   ${pad('STREAM', nameWidth)}  ${pad('IN', 6)}OUT`;
  for (let i = 0; i < rows.length; i++) {
    if (table.length + rows[i].length + 20 > TABLE_MAX_CHARS) {
      table += `\n   +${rows.length - i} more`;
      break;
    }
    table += `\n${rows[i]}`;
  }

  const live = mtx.paths.filter((p) => p.live).length;
  const lines = [
    `## ${live} live${studioCount ? ` · ${studioCount} to studio` : ''}${lowCount ? ` · ${lowCount} low` : ''}`,
    `-# ${mtx.srtAddress ? `${mtx.srtAddress} · ` : ''}updated <t:${Math.floor(Date.now() / 1000)}:R>`,
  ];
  if (mtx.error) lines.push(`⚠️ ${mtx.error.slice(0, 300)}`);
  lines.push(rows.length ? `\`\`\`\n${table}\n\`\`\`` : 'No streams right now.');

  const embed = new EmbedBuilder()
    .setTitle('MediaMTX')
    .setDescription(lines.join('\n'))
    .setColor(mtx.error || lowCount ? 0xfee75c : live ? 0x57f287 : 0x4f545c);
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

/**
 * One unit's box, as a components-v2 container so the MediaMTX dropdown
 * and Go Live / Stop sit inside the box (embeds can only have them below):
 * name + status, stats, connections, then the dropdown above the button.
 */
export function buildUnitMessage(snap, mtx = null) {
  const style = STATE_STYLE[snap.state];
  const container = new ContainerBuilder().setAccentColor(style.color);
  const text = (content) => container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  const status = [`**${style.label}**`];
  if (snap.destination) status.push(snap.state === 'live' ? `to **${snap.destination}**` : `· Go Live → **${snap.destination}**`);
  const uptime = snap.state === 'live' ? formatUptime(snap.video.uptimeSec) : null;
  if (uptime) status.push(`for ${uptime}`);
  text(`### ${style.icon} ${snap.name}\n${status.join(' ')}`);

  if (snap.state !== 'offline') {
    const input =
      snap.video.inputConnected === false
        ? '❌ No input'
        : snap.video.inputConnected
          ? `✅ ${[snap.video.resolution, snap.video.fps && `${snap.video.fps}fps`].filter(Boolean).join(' ') || 'Connected'}`
          : '—';
    const upSims = snap.sims.filter((s) => s.connected !== false).length;
    const stats = [
      `**Bitrate** ${formatBitrate(snap.totalKbps)}`,
      `**Input** ${input}`,
      `**SIMs** ${snap.sims.length ? `${upSims}/${snap.sims.length} up` : '—'}`,
    ];
    if (snap.battery !== null) stats.push(`**Battery** ${snap.charging ? '🔌' : '🔋'} ${Math.round(snap.battery)}%`);
    text(stats.join('  ·  '));

    const links = snap.interfaces.map(simLine);
    if (links.length) text(`**Connections**\n${links.join('\n')}`.slice(0, 2000));
    if (!snap.detailsOk) text('-# Live details unavailable right now.');
  }

  text(`-# ${[snap.product, snap.serial, snap.swVersion && `SW ${snap.swVersion}`].filter(Boolean).join(' · ') || snap.id}`);
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const mtxRow = snap.state === 'offline' ? null : buildMtxSelectRow(snap, mtx);
  if (mtxRow) container.addActionRowComponents(mtxRow);
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      snap.state === 'live'
        ? new ButtonBuilder().setCustomId(`${STOP_PREFIX}${snap.id}`).setLabel('Stop Stream').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
        : new ButtonBuilder()
            .setCustomId(`${GO_LIVE_PREFIX}${snap.id}`)
            .setLabel('Go Live')
            .setEmoji('🔴')
            .setStyle(ButtonStyle.Success)
            .setDisabled(snap.state === 'offline'),
    ),
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** Comparable form of a rendered message, minus the standing messages' always-changing "updated" time. */
export function messageKey(payload) {
  return JSON.stringify({
    embeds: (payload.embeds ?? []).map((e) => {
      const data = e.toJSON();
      return { ...data, description: data.description?.replace(/<t:\d+:R>/g, '') };
    }),
    components: (payload.components ?? []).map((c) => c.toJSON()),
    flags: payload.flags ?? 0,
  });
}
