import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { chunkMessage, formatTurnStats } from '../sessions/reply.js';
import { logEvent } from '../log-channel.js';
import { isConfigured, listFields, refreshShop } from './client.js';
import { applyEdit, runUndo } from './apply.js';
import { proposeEdits } from './editor.js';
import { validateEdits, describeEdit } from './edits.js';
import { getSiteChannelId, setSiteChannelId } from './store.js';

const APPLY_BUTTON_ID = 'site:apply';
const CANCEL_BUTTON_ID = 'site:cancel';
const UNDO_BUTTON_ID = 'site:undo';
const REFRESH_BUTTON_ID = 'site:refresh';

// What the site accepts (it checks the bytes itself; this just gives a clearer message sooner).
const IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Earlier messages are passed to Claude so follow-ups ("no, the other one")
// make sense. Kept short and short-lived — each request is otherwise
// independent, which is what keeps it cheap.
const HISTORY_ENTRIES = 6;
const HISTORY_MAX_AGE_MS = 30 * 60 * 1000;
const HISTORY_ENTRY_CHARS = 600;
// Proposals awaiting Apply, and applied ones that can still be undone. In
// memory only: after a restart old buttons just say they've expired.
const MAX_REMEMBERED = 20;

/** @type {Map<string, { role: 'user' | 'assistant', text: string, at: number }[]>} by channel id */
const historyByChannel = new Map();
/** @type {Map<string, { edits: object[], images: { name: string, buffer: Buffer }[] }>} by preview message id */
const pendingByMessage = new Map();
/** @type {Map<string, object[]>} undo steps, by the message carrying the Undo button */
const undoByMessage = new Map();
const busyChannels = new Set();

function rememberCapped(map, key, value) {
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

function recentHistory(channelId) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  return (historyByChannel.get(channelId) ?? []).filter((h) => h.at >= cutoff);
}

function remember(channelId, role, text) {
  const entries = [...recentHistory(channelId), { role, text: text.slice(0, HISTORY_ENTRY_CHARS), at: Date.now() }];
  historyByChannel.set(channelId, entries.slice(-HISTORY_ENTRIES));
}

function isEditor(member) {
  const roles = member?.roles?.cache ?? member?.roles;
  if (!roles) return false;
  return roles.has ? roles.has(config.site.roleId) : roles.includes(config.site.roleId);
}

export function isSiteInteraction(customId) {
  return customId.startsWith('site:');
}

/** True if `message` was sent in its guild's site editor channel. */
export function isSiteChannel(message) {
  return Boolean(message.guildId) && getSiteChannelId(message.guildId) === message.channelId;
}

/** `/site set-channel` — makes a channel the place staff type website edits. */
export async function handleSetSiteChannel(interaction) {
  if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
    await interaction.reply({ content: 'You need the **Manage Channels** permission to do that.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!isConfigured()) {
    await interaction.reply({
      content:
        "🌐 The website editor isn't set up — the bot needs `SITE_CONTENT_URL` (the site's address) and " +
        "`SITE_CONTENT_API_KEY` (the same value as the site's `CONTENT_API_KEY`) in Coolify, then a redeploy.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  try {
    await channel.send({
      content:
        '🌐 **Website editor** — type what you want changed on the site, like "change Friday\'s hours to 8:30am – 4pm", ' +
        'or attach a photo and say where it goes. You get a preview to approve before anything goes live.\n' +
        `-# Text and photos only · changes are live straight away, no deploy · needs the <@&${config.site.roleId}> role`,
      allowedMentions: { parse: [] },
    });
    setSiteChannelId(interaction.guildId, channel.id);
    await interaction.reply({ content: `✅ ${channel} is now the website editor.`, flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: `❌ Couldn't post in ${channel}: ${err.message}`.slice(0, 2000), flags: MessageFlags.Ephemeral });
  }
}

// How many item names to list per heading before "…and N more".
const REFRESH_NAMES_SHOWN = 15;

function refreshLine(heading, names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const shown = names.slice(0, REFRESH_NAMES_SHOWN).join(', ');
  const more = names.length > REFRESH_NAMES_SHOWN ? ` …and ${names.length - REFRESH_NAMES_SHOWN} more` : '';
  return `-# • ${heading} (${names.length}): ${shown}${more}`;
}

/**
 * The Shop refresh button (and `/site shop-refresh`) — reloads the site's
 * shop from Rentman straight away. Always answers with a new message, so
 * the message the button sits under (e.g. a pending proposal) is untouched.
 */
export async function handleShopRefresh(interaction) {
  if (!isEditor(interaction.member)) {
    await interaction.reply({ content: "You don't have permission to edit the site.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!isConfigured()) {
    await interaction.reply({
      content: "🌐 The website editor isn't set up on the bot yet (`SITE_CONTENT_URL` / `SITE_CONTENT_API_KEY`).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    const { total, added, removed, imagesChanged } = await refreshShop();
    const changes = [refreshLine('Added', added), refreshLine('Removed', removed), refreshLine('New picture', imagesChanged)].filter(Boolean);
    const lines = [
      `🔄 ${interaction.user} refreshed the shop from Rentman — ${plural(total, 'item')} on the site.`,
      ...(changes.length > 0 ? changes : ['-# Nothing had changed since the last load.']),
    ];
    await interaction.editReply({ content: lines.join('\n').slice(0, 2000), components: [buildRefreshRow()], allowedMentions: { parse: [] } });
    logEvent(interaction.guildId, `🔄 ${interaction.user} refreshed the website's shop from Rentman.`);
  } catch (err) {
    console.error('[site] shop refresh failed:', err);
    await interaction.editReply(`❌ Couldn't refresh the shop: ${err.message}`.slice(0, 2000));
  }
}

/** Downloads a message's photos into memory. Returns `{ images, skipped }` (names of ones the site wouldn't accept). */
async function downloadImages(message) {
  const images = [];
  const skipped = [];
  for (const attachment of message.attachments.values()) {
    const name = attachment.name || 'photo';
    const type = attachment.contentType?.split(';')[0] ?? '';
    const res = IMAGE_CONTENT_TYPES.has(type) && attachment.size <= MAX_IMAGE_BYTES ? await fetch(attachment.url) : null;
    if (!res?.ok) {
      skipped.push(name);
      continue;
    }
    images.push({ name, buffer: Buffer.from(await res.arrayBuffer()) });
  }
  return { images, skipped };
}

// Goes under every reply in the editor channel, next to whatever else is there.
function refreshButton() {
  return new ButtonBuilder().setCustomId(REFRESH_BUTTON_ID).setLabel('Shop refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary);
}

function buildProposalRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(APPLY_BUTTON_ID).setLabel('Apply to site').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CANCEL_BUTTON_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    refreshButton(),
  );
}

function buildUndoRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(UNDO_BUTTON_ID).setLabel('Undo').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    refreshButton(),
  );
}

function buildRefreshRow() {
  return new ActionRowBuilder().addComponents(refreshButton());
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A message in the site editor channel: asks Claude which fields it means,
 * then posts a before/after preview with Apply / Cancel. Nothing touches
 * the site until Apply.
 */
export async function handleSiteMessage(message) {
  if (!isEditor(message.member)) return;
  if (!isConfigured()) {
    await message.reply("🌐 The website editor isn't set up on the bot yet (`SITE_CONTENT_URL` / `SITE_CONTENT_API_KEY`).");
    return;
  }
  const text = message.content.trim();
  if (!text && message.attachments.size === 0) return;
  if (busyChannels.has(message.channelId)) {
    await message.reply('⏳ Still working on the previous request — send this again in a moment.');
    return;
  }

  busyChannels.add(message.channelId);
  const thinking = await message.reply('🤔 Working out what to change...');
  try {
    const { images, skipped } = await downloadImages(message);
    const imageNames = images.map((i) => i.name);
    const skippedNote =
      skipped.length > 0 ? `⚠️ Skipped ${skipped.map((n) => `\`${n}\``).join(', ')} — photos must be JPEG, PNG or WebP, up to 10 MB.` : null;
    if (!text && images.length === 0) {
      await thinking.edit(skippedNote);
      return;
    }

    const fields = await listFields();
    const { text: replyText, edits: rawEdits, result } = await proposeEdits({
      fields,
      history: recentHistory(message.channelId),
      imageNames,
      text,
    });
    remember(message.channelId, 'user', `${text}${imageNames.length > 0 ? ` [attached: ${imageNames.join(', ')}]` : ''}`);
    remember(message.channelId, 'assistant', replyText || '(proposed changes)');

    const { edits, problems } = validateEdits(rawEdits ?? [], fields, images.length);
    const stats = formatTurnStats(result, 0);
    const body = [replyText, ...problems.map((p) => `⚠️ ${p}`), skippedNote, ...edits.map((e) => describeEdit(e, imageNames))]
      .filter(Boolean)
      .join('\n\n');

    const chunks = chunkMessage(body || "I couldn't work out a change from that — try rephrasing it.");
    await thinking.edit({ content: chunks[0], allowedMentions: { parse: [] } });
    let last = thinking;
    for (const extra of chunks.slice(1)) {
      last = await message.channel.send({ content: extra, allowedMentions: { parse: [] } });
    }

    if (edits.length === 0) {
      if (stats) await message.channel.send({ content: `-# ${stats}`, components: [buildRefreshRow()] });
      else await last.edit({ components: [buildRefreshRow()] });
      return;
    }
    const prompt = await message.channel.send({
      content: `Apply ${edits.length === 1 ? 'this change' : `these ${edits.length} changes`} to the live site?${stats ? `\n-# ${stats}` : ''}`,
      components: [buildProposalRow()],
    });
    rememberCapped(pendingByMessage, prompt.id, { edits, images });
  } catch (err) {
    console.error('[site] request failed:', err);
    await thinking.edit(`❌ ${err.message}`.slice(0, 2000)).catch(() => {});
  } finally {
    busyChannels.delete(message.channelId);
  }
}

const LIST_ACTIONS = { add: 'item added', update: 'item changed', remove: 'item removed' };

/** One line for the "updated the site" summary and the activity log. */
function appliedLabel(edit) {
  return LIST_ACTIONS[edit.kind] ? `${edit.field.label} (${LIST_ACTIONS[edit.kind]})` : edit.field.label;
}

async function handleApply(interaction) {
  const entry = pendingByMessage.get(interaction.message.id);
  if (!entry) {
    await interaction.update({ content: '⌛ This proposal has expired — send the request again.', components: [buildRefreshRow()] });
    return;
  }
  pendingByMessage.delete(interaction.message.id);
  await interaction.update({ content: '⏳ Applying...', components: [] });

  const applied = [];
  const failed = [];
  const undoSteps = [];
  for (const edit of entry.edits) {
    const { field } = edit;
    try {
      const undoStep = await applyEdit(edit, entry.images);
      applied.push(appliedLabel(edit));
      if (undoStep) undoSteps.push(undoStep);
    } catch (err) {
      failed.push(`**${field.label}**: ${err.message}`);
    }
  }

  const lines = [];
  if (applied.length > 0) {
    lines.push(`✅ ${interaction.user} updated the site — ${plural(applied.length, 'change')} live now. Refresh the page to see ${applied.length === 1 ? 'it' : 'them'}.`);
    lines.push(...applied.map((label) => `-# • ${label}`));
  }
  if (failed.length > 0) lines.push(`❌ ${plural(failed.length, 'change')} didn't go through:`, ...failed.map((f) => `-# • ${f}`));
  if (applied.length > undoSteps.length) {
    lines.push(
      undoSteps.length > 0
        ? "-# Undo won't cover everything here: a list reset, or a photo that couldn't be saved first, can't be brought back."
        : "-# This can't be undone from here.",
    );
  }

  if (undoSteps.length > 0) rememberCapped(undoByMessage, interaction.message.id, undoSteps);
  await interaction.editReply({
    content: lines.join('\n').slice(0, 2000),
    components: [undoSteps.length > 0 ? buildUndoRow() : buildRefreshRow()],
    allowedMentions: { parse: [] },
  });
  if (applied.length > 0) {
    remember(interaction.channelId, 'assistant', '(The person approved those changes and they are now live.)');
    logEvent(interaction.guildId, `🌐 ${interaction.user} updated the website: ${applied.join(', ')}`);
  }
}

async function handleCancel(interaction) {
  pendingByMessage.delete(interaction.message.id);
  remember(interaction.channelId, 'assistant', '(The person cancelled those changes; nothing was applied.)');
  await interaction.update({ content: `🚫 ${interaction.user} cancelled — nothing was changed.`, components: [buildRefreshRow()], allowedMentions: { parse: [] } });
}

async function handleUndo(interaction) {
  const steps = undoByMessage.get(interaction.message.id);
  if (!steps) {
    await interaction.reply({ content: "This can't be undone any more — ask for the change you want instead.", flags: MessageFlags.Ephemeral });
    return;
  }
  undoByMessage.delete(interaction.message.id);
  await interaction.update({ components: [buildRefreshRow()] });

  const failed = [];
  // Newest first, so list items go back into the positions they came from.
  for (const step of [...steps].reverse()) {
    await runUndo(step).catch((err) => failed.push(`\`${step.key}\`: ${err.message}`));
  }
  remember(interaction.channelId, 'assistant', '(The person undid those changes; the site is back as it was before them.)');
  await interaction.followUp({
    content:
      failed.length === 0
        ? `↩️ ${interaction.user} undid that — the site is back to how it was.`
        : `↩️ ${interaction.user} undid that, but ${plural(failed.length, 'field')} couldn't be put back:\n${failed.map((f) => `-# • ${f}`).join('\n')}`.slice(0, 2000),
    allowedMentions: { parse: [] },
  });
  logEvent(interaction.guildId, `↩️ ${interaction.user} undid a website update.`);
}

/** Apply / Cancel under a proposal, Undo under an applied one, and Shop refresh under any of them. */
export async function handleSiteInteraction(interaction) {
  if (!isEditor(interaction.member)) {
    await interaction.reply({ content: "You don't have permission to edit the site.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId === REFRESH_BUTTON_ID) return handleShopRefresh(interaction);
  if (interaction.customId === APPLY_BUTTON_ID) return handleApply(interaction);
  if (interaction.customId === CANCEL_BUTTON_ID) return handleCancel(interaction);
  if (interaction.customId === UNDO_BUTTON_ID) return handleUndo(interaction);
}
