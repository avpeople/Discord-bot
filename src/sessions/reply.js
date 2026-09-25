import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const COMMIT_BUTTON_ID = 'claude-session:commit';
export const KEEP_GOING_BUTTON_ID = 'claude-session:keep-going';
export const EXIT_BUTTON_ID = 'claude-session:exit';
export const OPTION_BUTTON_PREFIX = 'claude-session:option:';
export const CLOSE_PUSH_BUTTON_ID = 'claude-session:close-push';
export const CLOSE_EXIT_BUTTON_ID = 'claude-session:close-exit';
export const APPROVE_BASH_BUTTON_ID = 'claude-session:approve-bash';
export const DENY_BASH_BUTTON_ID = 'claude-session:deny-bash';

const DISCORD_MAX_LEN = 2000;
const MAX_OPTIONS = 5;

/**
 * Fallback for when Claude asserts it can't use Bash/a shell in prose
 * without ever actually attempting the tool call — which means no
 * tool_result denial ever fires (see session.js's OPTIONS_SYSTEM_PROMPT
 * for the primary fix: instructing Claude to always try first). That
 * instruction isn't 100% reliable in practice (confirmed recurring live,
 * even in fresh sessions), so this is a second, independent detection
 * path: scan the final reply text for the pattern "bash/shell ... not
 * available/isn't enabled/can't run" and treat it the same as a real
 * denial, offering the Approve/Deny prompt anyway. Deliberately requires
 * BOTH a bash/shell-tool mention AND an unavailability phrase within a
 * short span of each other, not just either alone, to avoid false
 * positives on unrelated "I can't do X" sentences.
 */
export function looksLikeBashUnavailableClaim(replyText) {
  // Pattern A: "bash/shell ... isn't/aren't/not ... available/enabled/possible"
  //   e.g. "Bash isn't available in this environment"
  // Pattern B: "no shell/bash access/tool" — a distinct phrasing that
  //   doesn't fit pattern A's word order at all (confirmed live: "this
  //   environment has no shell access" matched neither the old pattern
  //   nor a reworded version of it, so this is a separate alternative
  //   rather than a tweak to pattern A).
  return (
    /\b(bash|shell)\b[^.!?\n]{0,80}\b(isn'?t|aren'?t|is not|are not|not)\b[^.!?\n]{0,20}\b(available|enabled|possible)\b/i.test(
      replyText,
    ) || /\bno\b[^.!?\n]{0,20}\b(bash|shell)\b[^.!?\n]{0,20}\b(access|tool)\b/i.test(replyText)
  );
}

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

/**
 * The Approve / Deny row shown when Claude's turn was denied a tool
 * (currently always Bash — see session.js). Approve re-sends the same
 * message with Bash allowed for that one re-run; Deny leaves Claude's
 * "I can't do that" response as the final answer. No Exit button here —
 * closing mid-approval isn't a case worth a dedicated button, /code close
 * or an Exit on an earlier message still works.
 */
export function buildBashApprovalRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(APPROVE_BASH_BUTTON_ID).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(DENY_BASH_BUTTON_ID).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
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
