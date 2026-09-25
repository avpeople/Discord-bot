import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';

export const COMMIT_BUTTON_ID = 'claude-session:commit';
export const KEEP_GOING_BUTTON_ID = 'claude-session:keep-going';
export const EXIT_BUTTON_ID = 'claude-session:exit';
export const OPTION_BUTTON_PREFIX = 'claude-session:option:';
export const CLOSE_PUSH_BUTTON_ID = 'claude-session:close-push';
export const CLOSE_EXIT_BUTTON_ID = 'claude-session:close-exit';
export const STOP_BUTTON_ID = 'claude-session:stop';
export const SHOW_CHANGES_BUTTON_ID = 'claude-session:show-changes';
export const FRESH_START_BUTTON_ID = 'claude-session:fresh-start';
export const KEEP_ALIVE_BUTTON_ID = 'claude-session:keep-alive';
export const UNDO_BUTTON_PREFIX = 'claude-session:undo:'; // + turn id
export const REVERT_BUTTON_PREFIX = 'claude-session:revert:'; // + PR number
export const REVERT_CONFIRM_PREFIX = 'claude-session:revert-confirm:'; // + PR number
// Under the repo picker. The ":refresh" variants sit on the status reply
// itself and update it in place instead of sending a new one.
export const SESSIONS_STATUS_BUTTON_ID = 'claude-session:sessions-status';
export const COOLIFY_STATUS_BUTTON_ID = 'claude-session:coolify-status';
export const STATUS_REFRESH_SUFFIX = ':refresh';
// Controls under the session's welcome message.
export const PANEL_MODEL_SELECT_ID = 'claude-session:panel-model';
export const PANEL_COMMIT_BUTTON_ID = 'claude-session:panel-commit';
export const PANEL_CLOSE_BUTTON_ID = 'claude-session:panel-close';
export const PANEL_INIT_BUTTON_ID = 'claude-session:panel-init';

const MODEL_CHOICES = [
  { value: 'sonnet', label: 'Sonnet', description: 'Fast and cheaper — good for most tasks' },
  { value: 'opus', label: 'Opus', description: 'Most capable, most expensive' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest and cheapest — simple tasks' },
  { value: 'default', label: 'Default', description: "The bot's default model" },
];

/**
 * The control panel under a session's welcome message: a model dropdown
 * (showing the current one), then Commit / Show Changes / Close, plus
 * Project Notes when the repo has no CLAUDE.md yet. `model` is the
 * session's model (null = default); `defaultModel` is what "Default"
 * resolves to (CLAUDE_MODEL, e.g. 'sonnet'), shown in its label — null if
 * unset, meaning Claude Code's own account default.
 */
export function buildSessionPanelRows({ model, hasProjectNotes, defaultModel }) {
  const defaultName = defaultModel
    ? MODEL_CHOICES.find((c) => c.value === defaultModel)?.label ?? defaultModel
    : 'account setting';
  const select = new StringSelectMenuBuilder()
    .setCustomId(PANEL_MODEL_SELECT_ID)
    .setPlaceholder('Model')
    .addOptions(
      MODEL_CHOICES.map((c) => ({
        label: c.value === 'default' ? `Model: Default (${defaultName})` : `Model: ${c.label}`,
        description: c.description,
        value: c.value,
        default: c.value === (model ?? 'default'),
      })),
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_COMMIT_BUTTON_ID).setLabel('Commit').setEmoji('📦').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(SHOW_CHANGES_BUTTON_ID).setLabel('Show Changes').setEmoji('📄').setStyle(ButtonStyle.Secondary),
  );
  if (!hasProjectNotes) {
    buttons.addComponents(
      new ButtonBuilder().setCustomId(PANEL_INIT_BUTTON_ID).setLabel('Project Notes').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.addComponents(
    new ButtonBuilder().setCustomId(PANEL_CLOSE_BUTTON_ID).setLabel('Close').setEmoji('🚪').setStyle(ButtonStyle.Danger),
  );

  return [new ActionRowBuilder().addComponents(select), buttons];
}

const DISCORD_MAX_LEN = 2000;
const MAX_OPTIONS = 5;

function truncate(text, max) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * One short progress line for a tool_use block, shown live in the
 * "Thinking..." message while a turn runs. `dir` is the session's working
 * directory, used to shorten absolute file paths.
 */
export function describeToolUse(block, dir) {
  const input = block.input ?? {};
  const file = (p) => `\`${truncate(p && path.isAbsolute(p) ? path.relative(dir, p) || p : p, 60)}\``;
  switch (block.name) {
    case 'Read':
      return `📖 Reading ${file(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `✏️ Editing ${file(input.file_path)}`;
    case 'Write':
      return `📝 Writing ${file(input.file_path)}`;
    case 'Bash':
      return `⚙️ Running \`${truncate(input.command, 70)}\``;
    case 'Grep':
      return `🔎 Searching for \`${truncate(input.pattern, 50)}\``;
    case 'Glob':
      return `🔎 Finding files \`${truncate(input.pattern, 50)}\``;
    case 'WebSearch':
      return `🌐 Searching the web for "${truncate(input.query, 60)}"`;
    case 'WebFetch':
      return `🌐 Reading ${truncate(input.url, 70)}`;
    case 'TodoWrite':
      return '📋 Updating its task list';
    default:
      return `🔧 ${block.name}`;
  }
}

/**
 * "3 tool calls · 45.2k tokens · ~$0.12" from a turn's `result` event
 * (`usage` + `total_cost_usd`, reported by Claude Code at the end of each
 * turn). Token count includes cached context re-read from earlier in the
 * conversation, which is why long chats climb. Cost is an estimate on
 * subscription logins. Pieces the event doesn't carry are left out.
 */
export function formatTurnStats(result, toolCallCount) {
  const parts = [];
  if (toolCallCount > 0) parts.push(`${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}`);
  const u = result?.usage;
  if (u) {
    const tokens =
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`);
  }
  if (typeof result?.total_cost_usd === 'number') parts.push(`~$${result.total_cost_usd.toFixed(2)}`);
  return parts.join(' · ');
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
 * The Commit / Keep Going / Show Changes / Fresh Start / Exit action row
 * shown after each Claude reply. Commit commits everything changed so far,
 * opens a PR, and immediately merges it into the default branch (see
 * manager.js commitAndMerge). Show Changes lists what Commit would include.
 * Fresh Start clears Claude's conversation history (not the files) to cut
 * per-message cost. Exit closes the session (discarding anything
 * uncommitted).
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
      new ButtonBuilder().setCustomId(SHOW_CHANGES_BUTTON_ID).setLabel('Show Changes').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(FRESH_START_BUTTON_ID).setLabel('Fresh Start').setStyle(ButtonStyle.Secondary),
    );
  }

  row.addComponents(new ButtonBuilder().setCustomId(EXIT_BUTTON_ID).setLabel('Exit').setStyle(ButtonStyle.Danger));
  return row;
}

/**
 * Second row under a reply that changed files: Undo puts those files back
 * as they were before this reply (see repo.js snapshotWorkingTree). Only
 * the latest such reply can be undone — the handler checks the turn id.
 */
export function buildUndoRow(turnId, { used = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(used ? `noop:undone:${turnId}` : `${UNDO_BUTTON_PREFIX}${turnId}`)
      .setLabel(used ? 'Undone ✓' : "Undo This Reply's Changes")
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(used),
  );
}

/** Revert button on the "Committed and merged" message — undoes that merge on GitHub (asks to confirm first). */
export function buildRevertRow(pullNumber, { used = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(used ? `noop:reverted:${pullNumber}` : `${REVERT_BUTTON_PREFIX}${pullNumber}`)
      .setLabel(used ? 'Reverted ✓' : 'Revert This Merge')
      .setEmoji('⏪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(used),
  );
}

export function buildRevertConfirmRow(pullNumber) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REVERT_CONFIRM_PREFIX}${pullNumber}`)
      .setLabel(`Yes, revert #${pullNumber}`)
      .setStyle(ButtonStyle.Danger),
  );
}

/** The Stop button on the live "Thinking..." message while a turn runs. */
export function buildStopRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(STOP_BUTTON_ID).setLabel('Stop').setStyle(ButtonStyle.Danger),
  );
}

/** The Keep Alive button on the warning posted shortly before the idle auto-close. */
export function buildIdleWarningRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(KEEP_ALIVE_BUTTON_ID).setLabel('Keep Alive').setStyle(ButtonStyle.Success),
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
