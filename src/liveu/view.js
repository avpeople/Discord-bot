import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

/**
 * Renders the LiveU status channel: a summary message at the top
 * ("2 live · 1 online · 5 offline") and one message per unit with its
 * details and Go Live / Stop buttons.
 */

export const GO_LIVE_PREFIX = 'liveu:go-live:';
export const STOP_PREFIX = 'liveu:stop:';

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
  const icon = sim.connected === false ? '❌' : sim.connected ? '📶' : '❔';
  const parts = [
    sim.connected === false ? 'down' : formatBitrate(sim.kbps),
    sim.carrier,
    sim.technology,
    sim.signal !== null ? `signal ${sim.signal}` : null,
  ].filter(Boolean);
  return `${icon} **${sim.name}** · ${parts.join(' · ')}`;
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

export function buildUnitMessage(snap) {
  const style = STATE_STYLE[snap.state];
  const embed = new EmbedBuilder()
    .setTitle(`${style.icon} ${snap.name}`)
    .setColor(style.color)
    .setFooter({ text: [snap.product, snap.serial, snap.swVersion && `SW ${snap.swVersion}`].filter(Boolean).join(' · ') || snap.id });

  const status = [`**${style.label}**`];
  if (snap.state === 'live' && snap.activePreset) status.push(`to **${snap.activePreset}**`);
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
    if (snap.battery !== null) embed.addFields({ name: 'Battery', value: `${snap.battery}%`, inline: true });

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

  return { content: '', embeds: [embed], components: [row] };
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
