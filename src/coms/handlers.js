import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  OverwriteType,
  PermissionsBitField,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { config } from '../config.js';
import * as coms from './client.js';
import { ComsBridge } from './bridge.js';
import { getComsConfig, allComsConfigs, updateComsConfig } from './store.js';
import { logEvent } from '../log-channel.js';

/**
 * Discord ↔ coms, two ways in:
 *
 *  - The coms landing panel (`/voice set-coms-channel`): a dropdown of coms
 *    channels. Picking one creates a voice chat "🎧 <coms channel>" in the
 *    landing channel's category and bridges it; the voice chat is deleted
 *    when the bridge ends.
 *  - `/voice join channel:<existing voice channel> coms:<coms channel>`.
 *
 * Either way a control panel goes in the voice chat's own text: who's on
 * coms, and Talk / Leave. Discord only lets a bot be in one voice channel
 * per server, so it's one bridge per guild.
 */

const TALK_PREFIX = 'coms:talk:';
const LEAVE_PREFIX = 'coms:leave:';
const OPEN_SELECT_ID = 'coms:open';
const SWITCH_PREFIX = 'coms:switch:';
const END_ID = 'coms:end';
const PANEL_DEBOUNCE_MS = 1000;
const TELEMETRY_MS = 30_000;
const EMPTY_CHECK_MS = 30_000;
const EMPTY_LEAVE_CHECKS = 4; // leave after ~2 minutes with nobody (but bots) in the voice channel
const LANDING_REFRESH_MS = 5 * 60_000; // pick up coms channels added/renamed on the coms server

// guildId -> { bridge, panel, startedBy, panelTimer, emptyChecks, createdChannel }
const active = new Map();
const starting = new Set(); // guildIds with a bridge mid-start, so two picks at once can't both start one
let client = null;
let background = false;

const ephemeral = (content, extra = {}) => ({ content: content.slice(0, 2000), flags: MessageFlags.Ephemeral, ...extra });
const v2 = (container) => ({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });

function canManage(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
}

/** Opening/ending from the landing panel: channel managers, or COMS_ROLE_ID (else ALLOWED_ROLE_ID). */
function canOperate(member) {
  if (canManage(member)) return true;
  const roles = member?.roles;
  return roles?.cache ? roles.cache.has(config.coms.roleId) : (roles?.includes?.(config.coms.roleId) ?? false);
}

export function isComsInteraction(customId) {
  return customId.startsWith('coms:');
}

// ── voice chat control panel ───────────────────────────────────────────────

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
  return v2(container);
}

function buildClosedPanel(bridge, reason) {
  return v2(
    new ContainerBuilder()
      .setAccentColor(0x4f545c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### 🎧 Coms bridge closed\n${bridge.voiceChannel} ↔ **${bridge.comsChannel.name}**\n-# ${reason}`),
      ),
  );
}

/** Edits the voice chat panel and the landing panel, at most once a second (joins/leaves on coms come in bursts). */
function schedulePanelUpdate(entry) {
  if (entry.panelTimer) return;
  entry.panelTimer = setTimeout(async () => {
    entry.panelTimer = null;
    if (entry.bridge.closed) return;
    await entry.panel?.edit(buildPanel(entry)).catch((err) => console.error('[coms] panel update failed:', err.message));
    await refreshLanding(entry.bridge.guild.id);
  }, PANEL_DEBOUNCE_MS);
}

// ── landing panel ──────────────────────────────────────────────────────────

async function buildLanding(guildId) {
  const container = new ContainerBuilder().setAccentColor(active.has(guildId) ? 0xed4245 : 0x5865f2);
  const text = (content) => container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  text('## 🎧 Coms\nPick a coms channel to open a voice chat bridged to it. Everyone in the voice chat hears coms; press **Talk** in the voice chat to speak on it.');

  const entry = active.get(guildId);
  if (entry) {
    const { bridge } = entry;
    const inVoice = bridge.voiceChannel.members?.filter((m) => !m.user.bot).size ?? 0;
    text(
      `🔴 **Open now:** ${bridge.voiceChannel} ↔ **${bridge.comsChannel.name}**\n` +
        `-# ${inVoice} in the voice chat · ${bridge.comsParticipants().length} on coms · Talk ${bridge.talk ? '🎙️ ON' : 'off'}`,
    );
  }

  let channels = [];
  let error = null;
  try {
    ({ channels = [] } = await coms.getConfig());
  } catch (err) {
    error = err.message;
  }
  if (error) text(`⚠️ Can't reach the coms server: ${error.slice(0, 300)}`);

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  if (channels.length) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(OPEN_SELECT_ID)
          .setPlaceholder(entry ? 'Switch to another coms channel...' : 'Open a coms channel...')
          .addOptions(
            channels.slice(0, 25).map((c) => ({
              label: String(c.name).slice(0, 100),
              description: c.description ? String(c.description).slice(0, 100) : undefined,
              value: String(c.id),
              emoji: entry?.bridge.comsChannel.id === String(c.id) ? '🔴' : '🎧',
            })),
          ),
      ),
    );
  } else if (!error) {
    text('-# No coms channels found for this bridge key.');
  }
  if (entry) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(END_ID).setLabel('End bridge').setStyle(ButtonStyle.Danger)),
    );
  }
  return v2(container);
}

async function fetchLandingMessage(guildId) {
  const cfg = getComsConfig(guildId);
  if (!cfg?.landingChannelId || !cfg.landingMessageId) return null;
  const channel = await client.channels.fetch(cfg.landingChannelId).catch(() => null);
  return channel?.messages.fetch(cfg.landingMessageId).catch(() => null) ?? null;
}

/** Re-renders the guild's landing panel, if it has one. */
async function refreshLanding(guildId) {
  if (!client) return;
  const message = await fetchLandingMessage(guildId);
  if (!message) return;
  await message.edit(await buildLanding(guildId)).catch((err) => console.error('[coms] landing update failed:', err.message));
}

// ── background ─────────────────────────────────────────────────────────────

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
  // Telemetry marks the bot online as a bridge in the coms admin console.
  const telemetry = () =>
    coms.sendTelemetry(reportedState()).catch((err) => console.error('[coms] telemetry failed:', err.message));
  telemetry();
  setInterval(telemetry, TELEMETRY_MS);

  setInterval(() => {
    for (const entry of active.values()) {
      const humans = entry.bridge.voiceChannel.members?.filter((m) => !m.user.bot).size ?? 1;
      entry.emptyChecks = humans ? 0 : entry.emptyChecks + 1;
      if (entry.emptyChecks >= EMPTY_LEAVE_CHECKS) entry.bridge.close('Left automatically — the voice chat was empty for 2 minutes');
    }
  }, EMPTY_CHECK_MS);

  setInterval(() => {
    for (const guildId of Object.keys(allComsConfigs())) refreshLanding(guildId);
  }, LANDING_REFRESH_MS);
}

/**
 * Called once from index.js after login. Re-renders each landing panel
 * (no bridge survives a restart) and deletes a voice chat the bot created
 * for a bridge that was running when it went down.
 */
export async function initComs(discordClient) {
  client = discordClient;
  if (!coms.isConfigured()) return;
  startBackground();
  for (const [guildId, cfg] of Object.entries(allComsConfigs())) {
    if (cfg.createdVoiceChannelId) {
      const leftover = await client.channels.fetch(cfg.createdVoiceChannelId).catch(() => null);
      await leftover?.delete('Coms bridge ended (bot restarted)').catch(() => {});
      updateComsConfig(guildId, { createdVoiceChannelId: null });
    }
    await refreshLanding(guildId);
  }
}

// ── starting and ending a bridge ───────────────────────────────────────────

async function findComsChannel(input) {
  const { channels = [] } = await coms.getConfig();
  return (
    channels.find((c) => String(c.id) === input) ??
    channels.find((c) => String(c.name).toLowerCase() === String(input).toLowerCase()) ??
    null
  );
}

/**
 * Starts a bridge into `voiceChannel`. If `createdChannel`, the voice chat is
 * the bot's own and is deleted when the bridge ends. Throws with a
 * user-facing message on failure (and cleans up after itself).
 */
async function startBridge({ guild, voiceChannel, comsChannel, user, createdChannel = false }) {
  const bridge = new ComsBridge({ guild, voiceChannel, comsChannel: { id: String(comsChannel.id), name: comsChannel.name } });
  const entry = { bridge, panel: null, startedBy: `${user}`, panelTimer: null, emptyChecks: 0, createdChannel };
  active.set(guild.id, entry);
  if (createdChannel) updateComsConfig(guild.id, { createdVoiceChannelId: voiceChannel.id });

  bridge.on('update', () => schedulePanelUpdate(entry));
  bridge.once('closed', async (reason) => {
    active.delete(guild.id);
    clearTimeout(entry.panelTimer);
    if (createdChannel) {
      await voiceChannel.delete('Coms bridge ended').catch(() => {});
      // Only forget it if a newer bridge (a switch) hasn't already recorded its own voice chat.
      if (getComsConfig(guild.id)?.createdVoiceChannelId === voiceChannel.id) {
        updateComsConfig(guild.id, { createdVoiceChannelId: null });
      }
    } else {
      await entry.panel?.edit(buildClosedPanel(bridge, reason)).catch(() => {});
    }
    await refreshLanding(guild.id);
    await logEvent(guild.id, `🔇 Coms bridge closed: **${voiceChannel.name}** ↔ **${comsChannel.name}** — ${reason}`, 'studio');
  });

  try {
    await bridge.start();
  } catch (err) {
    console.error('[coms] bridge start failed:', err);
    await bridge.close(`Couldn't start: ${err.message}`);
    throw new Error(`Couldn't start the bridge: ${err.message}`);
  }

  // The control panel lives in the voice chat's own text, where the people in it will see it.
  entry.panel = await voiceChannel.send(buildPanel(entry)).catch(() => null);
  startBackground();
  await refreshLanding(guild.id);
  await logEvent(guild.id, `🎧 ${user} opened ${voiceChannel} ↔ coms **${comsChannel.name}**`, 'studio');
  return entry;
}

const { Flags } = PermissionsBitField;
// The bot has to get in, talk, and post its Talk / Leave panel in the voice chat's text.
const BOT_ALLOW = [Flags.ViewChannel, Flags.Connect, Flags.Speak, Flags.SendMessages, Flags.EmbedLinks, Flags.ReadMessageHistory];
// The coms role has to see and join it, and talk to each other in it.
const ROLE_ALLOW = [Flags.ViewChannel, Flags.Connect, Flags.Speak];

/**
 * Permissions for a created voice chat: the category's own overwrites (so it
 * stays as private as, say, Studio is), plus explicit access for the bot and
 * the coms role — a private category would otherwise lock both of them out.
 */
function voiceChatPermissions(guild, parent) {
  const overwrites = new Map(); // id -> { id, type, allow: bitfield, deny: bitfield }
  for (const o of parent?.permissionOverwrites?.cache?.values() ?? []) {
    overwrites.set(o.id, { id: o.id, type: o.type, allow: new PermissionsBitField(o.allow), deny: new PermissionsBitField(o.deny) });
  }
  const grant = (id, type, perms) => {
    if (!id) return;
    const o = overwrites.get(id) ?? { id, type, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
    o.allow.add(perms);
    o.deny.remove(perms);
    overwrites.set(id, o);
  };
  const me = guild.members.me;
  grant(me.id, OverwriteType.Member, BOT_ALLOW);
  grant(me.roles?.botRole?.id, OverwriteType.Role, BOT_ALLOW);
  if (guild.roles?.cache?.has(config.coms.roleId)) grant(config.coms.roleId, OverwriteType.Role, ROLE_ALLOW);
  return [...overwrites.values()];
}

/** Landing panel: creates "🎧 <coms channel>" next to the landing channel and bridges it. */
async function openFromLanding(interaction, comsChannelId) {
  const comsChannel = await findComsChannel(comsChannelId);
  if (!comsChannel) throw new Error('That coms channel no longer exists.');

  const me = interaction.guild.members.me;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    throw new Error('I need the **Manage Channels** permission to create the voice chat.');
  }
  const parent = interaction.channel?.parent ?? null; // same category as the landing panel (e.g. Studio)
  let voiceChannel;
  try {
    voiceChannel = await interaction.guild.channels.create({
      name: `🎧 ${comsChannel.name}`.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: parent?.id ?? null,
      permissionOverwrites: voiceChatPermissions(interaction.guild, parent),
      reason: `Coms bridge to "${comsChannel.name}", opened by ${interaction.user.tag}`,
    });
  } catch (err) {
    // Discord only lets a bot grant permissions it has itself (or Manage Roles lets it grant any).
    if (err.code === 50013) {
      throw new Error(
        "Discord wouldn't let me set the voice chat's permissions. Give the bot's role **View Channel, Connect, Speak and Send Messages** (server-wide), or **Manage Roles**, then try again.",
      );
    }
    throw err;
  }
  try {
    await startBridge({ guild: interaction.guild, voiceChannel, comsChannel, user: interaction.user, createdChannel: true });
  } catch (err) {
    await voiceChannel.delete('Coms bridge failed to start').catch(() => {});
    throw err;
  }
  return voiceChannel;
}

// ── commands ───────────────────────────────────────────────────────────────

function notConfigured(interaction) {
  return interaction.reply(
    ephemeral(
      "Coms isn't set up on the bot — create a bridge in the coms admin console (Bridges tab), then set `COMS_API_URL` and `COMS_BRIDGE_KEY` and redeploy.",
    ),
  );
}

/** Autocomplete for `/voice join`'s `coms` option: the coms channels the bridge key can see. */
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

/** `/voice set-coms-channel channel:<text channel>` — posts the coms landing panel there. */
export async function handleSetComsChannel(interaction) {
  if (!canManage(interaction.member)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  if (!coms.isConfigured()) return notConfigured(interaction);

  const channel = interaction.options.getChannel('channel', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const old = await fetchLandingMessage(interaction.guildId);
  await old?.delete().catch(() => {});

  try {
    const message = await channel.send(await buildLanding(interaction.guildId));
    updateComsConfig(interaction.guildId, { landingChannelId: channel.id, landingMessageId: message.id });
    await interaction.editReply(
      `✅ ${channel} is now the coms landing page. Picking a coms channel there opens a voice chat in ${channel.parent ? `**${channel.parent.name}**` : 'the same category'}.`,
    );
  } catch (err) {
    await interaction.editReply(`❌ Couldn't post the landing panel: ${err.message}`.slice(0, 2000));
  }
}

/** `/voice join channel:<voice channel> coms:<coms channel>` — bridge an existing voice channel. */
export async function handleVoiceJoin(interaction) {
  if (!canManage(interaction.member)) return interaction.reply(ephemeral('You need the **Manage Channels** permission to do that.'));
  if (!coms.isConfigured()) return notConfigured(interaction);

  const voiceChannel = interaction.options.getChannel('channel', true);
  if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
    return interaction.reply(ephemeral(`${voiceChannel} isn't a voice channel.`));
  }
  const existing = active.get(interaction.guildId);
  if (existing || starting.has(interaction.guildId)) {
    return interaction.reply(
      ephemeral(
        existing
          ? `The bot is already bridging ${existing.bridge.voiceChannel} ↔ **${existing.bridge.comsChannel.name}** — Discord only allows one voice channel per server. End it first.`
          : 'A coms bridge is starting right now — try again in a moment.',
      ),
    );
  }
  const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) {
    return interaction.reply(ephemeral(`I need **Connect** and **Speak** in ${voiceChannel}.`));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  starting.add(interaction.guildId);
  try {
    const comsChannel = await findComsChannel(interaction.options.getString('coms', true));
    if (!comsChannel) return interaction.editReply('❌ No coms channel by that name — pick one from the list.');
    const entry = await startBridge({ guild: interaction.guild, voiceChannel, comsChannel, user: interaction.user });
    await interaction.editReply(
      `✅ Bridged ${voiceChannel} ↔ coms **${comsChannel.name}**. Listening now; press **Talk** on the panel${entry.panel ? ` (${entry.panel.url})` : ''} to speak on coms.`,
    );
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`.slice(0, 2000));
  } finally {
    starting.delete(interaction.guildId);
  }
}

/** `/voice leave` */
export async function handleVoiceLeave(interaction) {
  if (!canOperate(interaction.member)) return interaction.reply(ephemeral("You don't have permission to end the coms bridge."));
  const entry = active.get(interaction.guildId);
  if (!entry) return interaction.reply(ephemeral("The bot isn't bridging anything right now."));
  await entry.bridge.close(`Closed by ${interaction.user.tag}`);
  return interaction.reply(ephemeral('✅ Ended the coms bridge.'));
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

// ── buttons and the landing dropdown ───────────────────────────────────────

async function handleOpen(interaction, comsChannelId) {
  if (!canOperate(interaction.member)) return interaction.reply(ephemeral("You don't have permission to open coms."));
  const guildId = interaction.guildId;
  const entry = active.get(guildId);

  if (entry?.bridge.comsChannel.id === comsChannelId) {
    return interaction.reply(ephemeral(`**${entry.bridge.comsChannel.name}** is already open: ${entry.bridge.voiceChannel}`));
  }
  if (starting.has(guildId)) return interaction.reply(ephemeral('A coms bridge is starting right now — try again in a moment.'));
  if (entry) {
    // One bridge per server: switching ends the current one, which drops everyone in its voice chat.
    const target = await findComsChannel(comsChannelId).catch(() => null);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${SWITCH_PREFIX}${comsChannelId}`)
        .setLabel(`Switch to ${target?.name ?? 'it'}`.slice(0, 80))
        .setStyle(ButtonStyle.Danger),
    );
    return interaction.reply(
      ephemeral(
        `**${entry.bridge.comsChannel.name}** is open in ${entry.bridge.voiceChannel} — the bot can only be in one voice chat per server. Switching ends it and disconnects everyone there.`,
        { components: [row] },
      ),
    );
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  starting.add(guildId);
  try {
    const voiceChannel = await openFromLanding(interaction, comsChannelId);
    await interaction.editReply(`✅ Opened ${voiceChannel} — join it to listen, and press **Talk** there to speak on coms.`);
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`.slice(0, 2000));
  } finally {
    starting.delete(guildId);
    await refreshLanding(guildId); // also resets the dropdown's shown selection
  }
}

async function handleSwitch(interaction, comsChannelId) {
  if (!canOperate(interaction.member)) return interaction.reply(ephemeral("You don't have permission to open coms."));
  const guildId = interaction.guildId;
  if (starting.has(guildId)) return interaction.update({ content: 'A coms bridge is starting right now — try again in a moment.', components: [] });
  await interaction.update({ content: '⏳ Switching...', components: [] });
  starting.add(guildId);
  try {
    await active.get(guildId)?.bridge.close(`Switched by ${interaction.user.tag}`);
    const voiceChannel = await openFromLanding(interaction, comsChannelId);
    await interaction.editReply(`✅ Switched — ${voiceChannel} is open.`);
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`.slice(0, 2000));
  } finally {
    starting.delete(guildId);
  }
}

/** Every `coms:*` button and the landing dropdown. */
export async function handleComsInteraction(interaction) {
  const id = interaction.customId;
  if (id === OPEN_SELECT_ID) return handleOpen(interaction, interaction.values[0]);
  if (id.startsWith(SWITCH_PREFIX)) return handleSwitch(interaction, id.slice(SWITCH_PREFIX.length));

  const entry = active.get(interaction.guildId);
  if (!entry) return interaction.reply(ephemeral('This bridge is no longer running.'));
  const { bridge } = entry;

  if (id === END_ID) {
    if (!canOperate(interaction.member)) return interaction.reply(ephemeral("You don't have permission to end the coms bridge."));
    await interaction.deferUpdate();
    await bridge.close(`Ended by ${interaction.user.tag}`);
    return;
  }

  // Talk / Leave on the voice chat panel: people in that voice chat (or operators).
  const inChannel = interaction.member?.voice?.channelId === bridge.voiceChannel.id;
  if (!inChannel && !canOperate(interaction.member)) {
    return interaction.reply(ephemeral(`Join ${bridge.voiceChannel} to use the coms bridge.`));
  }
  if (id.startsWith(TALK_PREFIX)) {
    bridge.setTalk(!bridge.talk);
    await interaction.update(buildPanel(entry));
    await refreshLanding(interaction.guildId);
    await logEvent(
      interaction.guildId,
      `${bridge.talk ? '🎙️' : '🔇'} ${interaction.user} turned Talk **${bridge.talk ? 'on' : 'off'}** — ${bridge.voiceChannel} → coms **${bridge.comsChannel.name}**`,
      'studio',
    );
    return;
  }
  if (id.startsWith(LEAVE_PREFIX)) {
    await interaction.deferUpdate();
    await bridge.close(`Closed by ${interaction.user.tag}`);
  }
}
