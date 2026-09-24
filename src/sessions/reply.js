import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const PUSH_BUTTON_ID = 'claude-session:push';
export const KEEP_GOING_BUTTON_ID = 'claude-session:keep-going';

const DISCORD_MAX_LEN = 2000;

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
