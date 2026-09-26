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
 * table so the columns line up — a status dot, the name, IN (something
 * publishing to it), OUT (something pulling it), and the bitrate. Only the
 * leading dot is an emoji, so the text columns stay aligned.
 *
 * Dot: 🟢 both in and out, 🟡 one of them, ⚫ neither. Rows are sorted the
 * same way (🟢 first).
 *
 * With MediaMTX's own API configured, IN/OUT cover every publisher and
 * reader (OUT shows how many), and bitrate is measured for every stream.
 * Without it they come from the site's camera → server / server → studio
 * events (so OUT only knows about the studio), and bitrate is only known
 * when the site flags it as low. See mediamtx/state.js.
 */
export function buildMediamtxMessage(mtx) {
  const pad = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
  const mbps = (kbps) => `${(kbps / 1000).toFixed(1)} Mbps`;

  const streams = mtx.paths.map((p) => {
    // Low-bitrate warnings only mean something while a feed is actually coming in.
    const warnings = p.in ? Object.entries(p.hops).filter(([, h]) => h?.status === 'warning') : [];
    return { ...p, warnings, activity: Number(Boolean(p.in)) + Number(Boolean(p.out)) };
  });
  streams.sort((a, b) => b.activity - a.activity);
  const nameWidth = Math.min(NAME_WIDTH_MAX, Math.max(6, ...streams.map((s) => s.path.length)));

  const inCount = streams.filter((s) => s.in).length;
  const outCount = streams.filter((s) => s.out).length;
  const lowCount = streams.filter((s) => s.warnings.length).length;
  const rows = streams.map((s) => {
    const dot = s.activity === 2 ? '🟢' : s.activity === 1 ? '🟡' : '⚫';
    const inText = s.in === null ? '?' : s.in ? '▶ in' : '—';
    const outText = s.out === null ? '?' : !s.out ? '—' : s.readers !== null ? `▶ ${s.readers}` : '▶ studio';
    let rate = s.in && s.inKbps !== null ? mbps(s.inKbps) : '—';
    const low = s.warnings.map(([hop, h]) => `low${h.bitrateMbps !== null ? ` ${h.bitrateMbps.toFixed(2)} Mbps` : ''} (${HOP_SHORT[hop] ?? hop})`);
    if (low.length) rate = rate === '—' ? low.join(', ') : `${rate}  ${low.join(', ')}`;
    return `${dot} ${pad(s.path, nameWidth)}  ${pad(inText, 6)}${pad(outText, 10)}${rate}`.trimEnd();
  });

  let table = `   ${pad('STREAM', nameWidth)}  ${pad('IN', 6)}${pad('OUT', 10)}BITRATE`;
  for (let i = 0; i < rows.length; i++) {
    if (table.length + rows[i].length + 20 > TABLE_MAX_CHARS) {
      table += `\n   +${rows.length - i} more`;
      break;
    }
    table += `\n${rows[i]}`;
  }

  const lines = [
    `## ${inCount} in · ${outCount} out${lowCount ? ` · ${lowCount} low` : ''}`,
    `-# ${mtx.srtAddress ? `${mtx.srtAddress} · ` : ''}updated <t:${Math.floor(Date.now() / 1000)}:R>`,
  ];
  if (mtx.error) lines.push(`⚠️ ${mtx.error.slice(0, 300)}`);
  lines.push(rows.length ? `\`\`\`\n${table}\n\`\`\`` : 'No streams right now.');

  const embed = new EmbedBuilder()
    .setTitle('MediaMTX')
    .setDescription(lines.join('\n'))
    .setColor(mtx.error || lowCount ? 0xfee75c : inCount ? 0x57f287 : 0x4f545c);
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
 * "Set destination → MediaMTX stream" dropdown: streams with a feed coming
 * in first, then the rest of the site's streams, then "Other…" to type a
 * name. The unit's current destination shows as selected. Only offered
 * when the site login (which gives the SRT address) is configured.
 */
function buildMtxSelectRow(snap, mtx) {
  if (!mtx?.srtAddress) return null;
  // Streams with a feed coming in first; the emoji shows which (a LiveU usually publishes to one that isn't yet).
  const ordered = [...mtx.paths.filter((p) => p.in), ...mtx.paths.filter((p) => !p.in)];
  const options = ordered.slice(0, 24).map((p) => ({
    label: p.path.slice(0, 100),
    value: p.path.slice(0, 100),
    emoji: p.in ? '🟢' : '⚫',
    default: snap.destination === p.path,
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
