import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const PUSH_BUTTON_ID = 'claude-session:push';
export const KEEP_GOING_BUTTON_ID = 'claude-session:keep-going';
export const OPTION_BUTTON_PREFIX = 'claude-session:option:';

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

/** The Push / Keep going action row shown after each Claude reply. */
export function buildPostReplyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PUSH_BUTTON_ID).setLabel('Push').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(KEEP_GOING_BUTTON_ID)
      .setLabel('Keep Going')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * A row of option buttons. Each button's customId only carries an index
 * (`claude-session:option:<n>`) — the option text itself is looked up
 * server-side from the session's `pendingOptions` (see handlers.js),
 * since Discord customIds are capped at 100 chars and option text can
 * exceed that once combined with a prefix.
 */
export function buildOptionsRow(options) {
  const row = new ActionRowBuilder();
  options.forEach((label, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${OPTION_BUTTON_PREFIX}${i}`)
        .setLabel(label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
  });
  return row;
}
