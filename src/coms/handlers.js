import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionsBitField,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import * as coms from './client.js';
import { ComsBridge } from './bridge.js';
import { logEvent } from '../log-channel.js';

/**
 * `/voice` — bridges a Discord voice channel to a coms channel (see
 * bridge.js), with a control panel posted in the voice channel's chat:
 * who's on coms, and Talk / Leave buttons. Discord only lets a bot be in
 * one voice channel per server, so it's one bridge per guild.
 */

const TALK_PREFIX = 'coms:talk:';
const LEAVE_PREFIX = 'coms:leave:';
const PANEL_DEBOUNCE_MS = 1000;
const TELEMETRY_MS = 30_000;
const EMPTY_CHECK_MS = 30_000;
const EMPTY_LEAVE_CHECKS = 4; // leave after ~2 minutes with nobody (but bots) in the voice channel

const active = new Map(); // guildId -> { bridge, panel, startedBy, panelTimer, emptyChecks }
let background = false;

const ephemeral = (content, extra = {}) => ({ content: content.slice(0, 2000), flags: MessageFlags.Ephemeral, ...extra });

function canManage(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

export function isComsInteraction(customId) {
  return customId.startsWith('coms:');
}

// ── control panel ──────────────────────────────────────────────────────────

function buildPanel(entry) {
  const { bridge } = entry;
  const container = new ContainerBuilder().setAccentColor(bridge.talk ? 0xed4245 : 0x57f287);
  const text = (content) => container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  text(`### 🎧 Coms bridge\n🔊 ${bridge.voiceChannel} ↔ **${bridge.comsChannel.name}** (coms)`);
  text(
    bridge.talk
      ? '🎙️ **Talk ON** — voices in this channel are going out on coms'
      : '🔇 **Talk off** — this channel is listening to coms',
  );
  const people = bridge.comsParticipants();
  text(`**On coms (${people.length})** ${people.length ? people.join(', ') : '—'}`.slice(0, 1500));
  text(
    `-# Discord ${bridge.discordReady ? '✅' : '⏳'} · Coms ${bridge.comsReady ? '✅' : '⏳ reconnecting'} · started <t:${Math.floor(bridge.startedAt / 1000)}:R> by ${entry.startedBy}`,
  );
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TALK_PREFIX}${bridge.guild.id}`)
        .setLabel(bridge.talk ? 'Talk ON — tap to stop' : 'Talk')
        .setEmoji(bridge.talk ? '🎙️' : '🔇')
        .setStyle(bridge.talk ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${LEAVE_PREFIX}${bridge.guild.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

function buildClosedPanel(bridge, reason) {
  const container = new ContainerBuilder()
    .setAccentColor(0x4f545c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎧 Coms bridge closed\n${bridge.voiceChannel} ↔ **${bridge.comsChannel.name}**\n-# ${reason}`,
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Edits the panel, at most once a second (joins/leaves on coms can come in bursts). */
function schedulePanelUpdate(entry) {
  if (entry.panelTimer) return;
  entry.panelTimer = setTimeout(async () => {
    entry.panelTimer = null;
    if (entry.bridge.closed) return;
    await entry.panel?.edit(buildPanel(entry)).catch((err) => console.error('[coms] panel update failed:', err.message));
  }, PANEL_DEBOUNCE_MS);
}

// ── background: telemetry to the coms admin console, auto-leave when empty ──

function reportedState() {
  return {
    kind: 'discord',
    bridges: [...active.values()].map(({ bridge }) => ({
      discordGuild: bridge.guild.name,
      discordChannel: bridge.voiceChannel.name,
      comsChannelId: bridge.comsChannel.id,
      comsChannel: bridge.comsChannel.name,
      talk: bridge.talk,
    })),
  };
}

function startBackground() {
  if (background) return;
  background = true;
  const telemetry = () =>
    coms.sendTelemetry(reportedState()).catch((err) => console.error('[coms] telemetry failed:', err.message));
  telemetry();
  setInterval(telemetry, TELEMETRY_MS);

  setInterval(() => {
    for (const entry of active.values()) {
      const humans = entry.bridge.voiceChannel.members?.filter((m) => !m.user.bot).size ?? 1;
      entry.emptyChecks = humans ? 0 : entry.emptyChecks + 1;
      if (entry.emptyChecks >= EMPTY_LEAVE_CHECKS) entry.bridge.close('Left automatically — the voice channel was empty for 2 minutes');
    }
  }, EMPTY_CHECK_MS);
}

/** Called once from index.js after login: marks the bot online as a bridge in the coms admin console. */
export function initComs() {
  if (coms.isConfigured()) startBackground();
}

// ── commands ───────────────────────────────────────────────────────────────

function notConfigured(interaction) {
  return interaction.reply(
    ephemeral(
      "Coms isn't set up on the bot — create a bridge in the coms admin console (Bridges tab), then set `COMS_API_URL` and `COMS_BRIDGE_KEY` and redeploy.",
    ),
  );
}

/** Autocomplete for the `coms` option: the coms channels the bridge key can see. */
export async function handleVoiceAutocomplete(interaction) {
  if (!coms.isConfigured()) return interaction.respond([]);
  const query = interaction.options.getFocused().toLowerCase();
  try {
    const { channels = [] } = await coms.getConfig();
    const matches = channels
      .filter((c) => `${c.name} ${c.shortName ?? ''}`.toLowerCase().includes(query))
      .slice(0, 25)
      .map((c) => ({ name: String(c.name).slice(0, 100), value: String(c.id) }));
    await interaction.respond(matches);
  } catch (err) {
    console.error('[coms] autocomplete failed:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}

/** `/voice join channel:<voice channel> coms:<coms channel>` */
export async function handleVoiceJoin(interaction) {
  if (!canManage(interaction.member)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  if (!coms.isConfigured()) return notConfigured(interaction);

  const voiceChannel = interaction.options.getChannel('channel', true);
  if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
    return interaction.reply(ephemeral(`${voiceChannel} isn't a voice channel.`));
  }
  const existing = active.get(interaction.guildId);
  if (existing) {
    return interaction.reply(
      ephemeral(
        `The bot is already bridging ${existing.bridge.voiceChannel} ↔ **${existing.bridge.comsChannel.name}** — Discord only allows one voice channel per server. Press **Leave** on its panel (or \`/voice leave\`) first.`,
      ),
    );
  }
  const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) {
    return interaction.reply(ephemeral(`I need **Connect** and **Speak** in ${voiceChannel}.`));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const comsInput = interaction.options.getString('coms', true);
  let comsChannel;
  try {
    const { channels = [] } = await coms.getConfig();
    comsChannel =
      channels.find((c) => String(c.id) === comsInput) ??
      channels.find((c) => String(c.name).toLowerCase() === comsInput.toLowerCase());
  } catch (err) {
    return interaction.editReply(`❌ Couldn't reach the coms server: ${err.message}`.slice(0, 2000));
  }
  if (!comsChannel) return interaction.editReply(`❌ No coms channel called \`${comsInput}\` — pick one from the list.`);

  const bridge = new ComsBridge({ guild: interaction.guild, voiceChannel, comsChannel: { id: String(comsChannel.id), name: comsChannel.name } });
  const entry = { bridge, panel: null, startedBy: `${interaction.user}`, panelTimer: null, emptyChecks: 0 };
  active.set(interaction.guildId, entry);
  bridge.on('update', () => schedulePanelUpdate(entry));
  bridge.once('closed', async (reason) => {
    active.delete(interaction.guildId);
    clearTimeout(entry.panelTimer);
    await entry.panel?.edit(buildClosedPanel(bridge, reason)).catch(() => {});
    await logEvent(interaction.guildId, `🔇 Coms bridge closed: ${voiceChannel} ↔ **${comsChannel.name}** — ${reason}`, 'studio');
  });

  try {
    await bridge.start();
  } catch (err) {
    console.error('[coms] bridge start failed:', err);
    await bridge.close(`Couldn't start: ${err.message}`);
    return interaction.editReply(`❌ Couldn't start the bridge: ${err.message}`.slice(0, 2000));
  }

  // The panel lives in the voice channel's own chat, where the people in it will see it.
  entry.panel =
    (await voiceChannel.send(buildPanel(entry)).catch(() => null)) ??
    (await interaction.channel?.send(buildPanel(entry)).catch(() => null));
  startBackground();
  await interaction.editReply(
    `✅ Bridged ${voiceChannel} ↔ coms **${comsChannel.name}**. Discord is listening; press **Talk** on the panel${entry.panel ? ` (${entry.panel.url})` : ''} to speak on coms.`,
  );
  await logEvent(interaction.guildId, `🎧 ${interaction.user} bridged ${voiceChannel} ↔ coms **${comsChannel.name}**`, 'studio');
}

/** `/voice leave` */
export async function handleVoiceLeave(interaction) {
  if (!canManage(interaction.member)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  const entry = active.get(interaction.guildId);
  if (!entry) return interaction.reply(ephemeral("The bot isn't bridging anything right now."));
  await entry.bridge.close(`Closed by ${interaction.user.tag}`);
  return interaction.reply(ephemeral('✅ Left the coms bridge.'));
}

/** `/voice status` */
export function handleVoiceStatus(interaction) {
  if (!coms.isConfigured()) return notConfigured(interaction);
  const entry = active.get(interaction.guildId);
  if (!entry) return interaction.reply(ephemeral("The bot isn't bridging anything right now."));
  const { bridge } = entry;
  const people = bridge.comsParticipants();
  return interaction.reply(
    ephemeral(
      `🔊 ${bridge.voiceChannel} ↔ **${bridge.comsChannel.name}** · Talk ${bridge.talk ? '🎙️ ON' : 'off'}\n` +
        `Discord ${bridge.discordReady ? '✅' : '⏳'} · Coms ${bridge.comsReady ? '✅' : '⏳'} · on coms: ${people.join(', ') || '—'}`,
    ),
  );
}

// ── panel buttons ──────────────────────────────────────────────────────────

/** Talk / Leave. Only people in the bridged voice channel (or channel managers) can use them. */
export async function handleComsButton(interaction) {
  const [, action, guildId] = interaction.customId.split(':');
  const entry = active.get(guildId);
  if (!entry) return interaction.reply(ephemeral('This bridge is no longer running.'));
  const { bridge } = entry;

  const inChannel = interaction.member?.voice?.channelId === bridge.voiceChannel.id;
  if (!inChannel && !canManage(interaction.member)) {
    return interaction.reply(ephemeral(`Join ${bridge.voiceChannel} to use the coms bridge.`));
  }

  if (action === 'talk') {
    bridge.setTalk(!bridge.talk);
    await interaction.update(buildPanel(entry));
    await logEvent(
      guildId,
      `${bridge.talk ? '🎙️' : '🔇'} ${interaction.user} turned Talk **${bridge.talk ? 'on' : 'off'}** — ${bridge.voiceChannel} → coms **${bridge.comsChannel.name}**`,
      'studio',
    );
    return;
  }
  if (action === 'leave') {
    await interaction.deferUpdate();
    await bridge.close(`Closed by ${interaction.user.tag}`);
  }
}
