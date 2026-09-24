import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const COMMIT_BUTTON_ID = 'claude-session:commit';
export const KEEP_GOING_BUTTON_ID = 'claude-session:keep-going';
export const EXIT_BUTTON_ID = 'claude-session:exit';
export const OPTION_BUTTON_PREFIX = 'claude-session:option:';
export const CLOSE_PUSH_BUTTON_ID = 'claude-session:close-push';
export const CLOSE_EXIT_BUTTON_ID = 'claude-session:close-exit';

const DISCORD_MAX_LEN = 2000;
const MAX_OPTIONS = 5;

/** Splits long text into Discord-message-sized chunks, breaking on newlines where possible. */
export function chunkMessage(text, maxLen = DISCORD_MAX_LEN) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Pulls a trailing ```options fenced block (see session.js's
 * OPTIONS_SYSTEM_PROMPT) out of a Claude reply, if present.
 * Returns { text, options } — text has the block stripped, options is
 * an array of { label, value } or null if no valid block was found.
 */
export function parseOptionsBlock(replyText) {
  const match = /```options\s*\n([\s\S]*?)```/.exec(replyText);
  if (!match) return { text: replyText, options: null };

  const lines = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const options = [];
  for (const line of lines) {
    const optMatch = /^[A-Za-z][).:-]\s*(.+)$/.exec(line);
    if (optMatch) options.push(optMatch[1].trim());
  }

  if (options.length === 0) return { text: replyText, options: null };

  const text = (replyText.slice(0, match.index) + replyText.slice(match.index + match[0].length)).trim();
  return { text: text || '(see options below)', options: options.slice(0, MAX_OPTIONS) };
}

/**
 * A Link-style "Open Session" button pointing straight at the new
 * channel. Discord has no API for a bot to force-navigate a user's
 * client to a channel — this is the closest equivalent: a one-tap jump
 * link, more prominent than the inline channel mention already in the
 * confirmation text. Link buttons need no customId/handler; Discord
 * opens the URL client-side.
 */
export function buildOpenSessionRow(guildId, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Open Session')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${channelId}`),
  );
}

/**
 * The Commit / Keep Going / Exit action row shown after each Claude reply.
 * Commit commits everything changed so far, opens a PR, and immediately
 * merges it into the default branch (see manager.js commitAndMerge).
 * Exit closes the session (discarding anything uncommitted).
 *
 * Once Commit or Keep Going is clicked on a given message, that message's
 * row collapses to just a disabled "used" version of whichever was
 * clicked, alongside a fresh, still-live Exit button — Exit is meant to
 * stay usable on every past message, not just the newest one.
 */
export function buildPostReplyRow({ used } = {}) {
  const row = new ActionRowBuilder();

  if (used === 'commit') {
    row.addComponents(
      new ButtonBuilder().setCustomId('noop:committed').setLabel('Committed ✓').setStyle(ButtonStyle.Success).setDisabled(true),
    );
  } else if (used === 'keep-going') {
    row.addComponents(
      new ButtonBuilder().setCustomId('noop:kept-going').setLabel('Kept Going ✓').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(COMMIT_BUTTON_ID).setLabel('Commit').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(KEEP_GOING_BUTTON_ID).setLabel('Keep Going').setStyle(ButtonStyle.Secondary),
    );
  }

  row.addComponents(new ButtonBuilder().setCustomId(EXIT_BUTTON_ID).setLabel('Exit').setStyle(ButtonStyle.Danger));
  return row;
}

/** The Push / Exit choice shown by `/code close`. */
export function buildClosePromptRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CLOSE_PUSH_BUTTON_ID)
      .setLabel('Push')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CLOSE_EXIT_BUTTON_ID).setLabel('Exit').setStyle(ButtonStyle.Danger),
  );
}

/**
 * The option buttons row plus a second row with Exit — a message can hold
 * multiple action rows, and option buttons can already fill a row to its
 * 5-button cap, so Exit gets its own row rather than competing for space.
 * Each option button's customId only carries an index
 * (`claude-session:option:<n>`) — the option text itself is looked up
 * server-side from the session's `pendingOptions` (see handlers.js),
 * since Discord customIds are capped at 100 chars and option text can
 * exceed that once combined with a prefix.
 */
export function buildOptionsRows(options) {
  const optionsRow = new ActionRowBuilder();
  options.forEach((label, i) => {
    optionsRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${OPTION_BUTTON_PREFIX}${i}`)
        .setLabel(label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
  });

  const exitRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(EXIT_BUTTON_ID).setLabel('Exit').setStyle(ButtonStyle.Danger),
  );

  return [optionsRow, exitRow];
}
