import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { buildRepoPickerReply, REPO_SELECT_ID } from './repo-picker.js';
import { createSessionChannel, CHAT_CATEGORY_NAME } from './channel.js';
import {
  buildPostReplyRow,
  buildOptionsRows,
  buildClosePromptRow,
  buildOpenSessionRow,
  buildStopRow,
  buildIdleWarningRow,
  buildUndoRow,
  buildRevertRow,
  buildRevertConfirmRow,
  buildSessionPanelRows,
  buildChatPanelRows,
  buildChatReplyRow,
  chunkMessage,
  parseOptionsBlock,
  describeToolUse,
  formatTurnStats,
  COMMIT_BUTTON_ID,
  KEEP_GOING_BUTTON_ID,
  EXIT_BUTTON_ID,
  OPTION_BUTTON_PREFIX,
  CLOSE_PUSH_BUTTON_ID,
  CLOSE_EXIT_BUTTON_ID,
  STOP_BUTTON_ID,
  SHOW_CHANGES_BUTTON_ID,
  FRESH_START_BUTTON_ID,
  KEEP_ALIVE_BUTTON_ID,
  UNDO_BUTTON_PREFIX,
  REVERT_BUTTON_PREFIX,
  REVERT_CONFIRM_PREFIX,
  SESSIONS_STATUS_BUTTON_ID,
  COOLIFY_STATUS_BUTTON_ID,
  STATUS_REFRESH_SUFFIX,
  PANEL_MODEL_SELECT_ID,
  PANEL_COMMIT_BUTTON_ID,
  PANEL_CLOSE_BUTTON_ID,
  PANEL_INIT_BUTTON_ID,
  NEW_CHAT_CHANNEL_BUTTON_ID,
} from './reply.js';
import { parseRepoSlug } from '../github.js';
import { pendingChanges, snapshotWorkingTree, restoreWorkingTree } from '../repo.js';
import * as coolify from '../coolify.js';
import { STATUS_DIVIDER, decorateResources, describeResource, buildAppSelectRow } from '../coolify-view.js';
import { downloadAttachments } from './attachments.js';
import { logEvent } from '../log-channel.js';
import { getClaudeUsage, formatSessionUsageLine } from '../claude-usage.js';

// Discord rate-limits message edits (roughly 5 per 5s per channel), so the
// live progress line is batched to at most one edit per this interval.
const PROGRESS_EDIT_INTERVAL_MS = 2000;
// How long the end-of-turn message waits on the usage endpoint before going without the bar.
const USAGE_LINE_TIMEOUT_MS = 3000;
const PROGRESS_LINES_SHOWN = 5;

const MODEL_LABELS = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

function modelLabel(model) {
  if (model) return MODEL_LABELS[model] ?? model;
  if (config.claude.defaultModel) return `${MODEL_LABELS[config.claude.defaultModel] ?? config.claude.defaultModel} (bot default)`;
  return 'the account default';
}

export function hasAccess(interaction) {
  const member = interaction.member;
  if (!member || !member.roles) return false;
  const roles = member.roles.cache ?? member.roles;
  return roles.has ? roles.has(config.discord.allowedRoleId) : roles.includes(config.discord.allowedRoleId);
}

function replyNoAccess(interaction) {
  return interaction.reply({
    content: "You don't have permission to use this command.",
    flags: MessageFlags.Ephemeral,
  });
}

/** `/code new` — shows the repo picker. */
export async function handleCodeNew(interaction) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const reply = await buildRepoPickerReply();
    await interaction.editReply(reply);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't load repos: ${err.message}`.slice(0, 2000));
  }
}

/**
 * Creates a session channel + session for a picked repo and posts the
 * welcome message into it. Shared by the ephemeral `/code new` picker and
 * the persistent picker channel, which differ only in how they report
 * progress/errors back (interaction reply vs. a temporary channel message).
 */
export async function createSessionForRepo({ guild, user, fullName, sessionManager }) {
  const { owner, name } = parseRepoSlug(fullName);
  const id = sessionManager.generateSessionId();
  const channel = await createSessionChannel({
    guild,
    ownerId: user.id,
    allowedRoleId: config.discord.allowedRoleId,
    repoFullName: fullName,
  });

  const session = await sessionManager.createSession({
    id,
    channelId: channel.id,
    guildId: guild.id,
    ownerId: user.id,
    owner,
    repo: name,
    base: undefined,
  });

  await channel.send(buildSessionPanel(session));

  logEvent(guild.id, `🟢 ${user} opened a session on **${fullName}**: ${channel}`);

  return channel;
}

/**
 * `/code chat`, or the Chat with Claude button under the repo picker —
 * opens a private channel with a plain Claude conversation (no repo).
 */
export async function handleCodeChat(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const channel = await createSessionChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      allowedRoleId: config.discord.allowedRoleId,
      repoFullName: 'chat',
      categoryName: CHAT_CATEGORY_NAME,
    });
    const session = await sessionManager.createChatSession({
      channelId: channel.id,
      guildId: interaction.guildId,
      ownerId: interaction.user.id,
    });
    await channel.send(buildSessionPanel(session));
    logEvent(interaction.guildId, `💬 ${interaction.user} opened a chat: ${channel}`);
    await interaction.editReply({
      content: `✅ Created ${channel}. Say hi!`,
      components: [buildOpenSessionRow(interaction.guildId, channel.id)],
    });
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't start a chat: ${err.message}`.slice(0, 2000));
  }
}

/**
 * `/code set-chat-channel` — posts a permanent Chat with Claude button in a
 * channel. The button never changes, so unlike the repo picker channel
 * there's nothing to store or resync on boot.
 */
export async function handleSetChatChannel(interaction) {
  if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
    await interaction.reply({ content: 'You need the **Manage Channels** permission to do that.', flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  try {
    await channel.send({
      content: '💬 **Chat with Claude** — opens a private channel for a plain conversation (no repo). Start as many as you like.',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(NEW_CHAT_CHANNEL_BUTTON_ID).setLabel('Chat with Claude').setEmoji('💬').setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    await interaction.reply({ content: `✅ ${channel} now has a Chat with Claude button.`, flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: `❌ Couldn't post in ${channel}: ${err.message}`.slice(0, 2000), flags: MessageFlags.Ephemeral });
  }
}

/** Replies privately and returns true if `session` is a chat — for repo-only buttons and commands. */
async function rejectIfChat(interaction, session) {
  if (!session.isChat) return false;
  await interaction.reply({ content: "That's only for code sessions — this is a plain chat.", flags: MessageFlags.Ephemeral });
  return true;
}

/** The session's welcome message: a short summary plus the control panel (model dropdown, Commit, Show Changes, Close...). */
function buildSessionPanel(session) {
  if (session.isChat) {
    return {
      content:
        '💬 **Chat with Claude** — just type. There\'s no repo here, just a conversation.\n' +
        '-# New Chat forgets the conversation so far · closes after 4h idle · attach images, logs or PDFs',
      components: buildChatPanelRows({ model: session.model, defaultModel: config.claude.defaultModel }),
    };
  }
  const hasProjectNotes = fs.existsSync(path.join(session.dir, 'CLAUDE.md'));
  return {
    content:
      `👋 **${session.owner}/${session.repo}** — just type what you want changed.\n` +
      `-# Push Live merges into \`${session.defaultBranch}\` and deploys · closes after 4h idle · attach images, logs or PDFs` +
      (hasProjectNotes ? '' : '\n-# 📝 No project notes yet — Project Notes has Claude write a CLAUDE.md, which saves tokens later'),
    components: buildSessionPanelRows({ model: session.model, hasProjectNotes, defaultModel: config.claude.defaultModel }),
  };
}

/** Model dropdown on the session panel — switches the model and updates the panel to show it. */
export async function handlePanelModelSelect(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'This session is closed.', flags: MessageFlags.Ephemeral });
    return;
  }
  const choice = interaction.values[0];
  session.setModel(choice === 'default' ? null : choice);
  await interaction.update(buildSessionPanel(session));
  await interaction.followUp({
    content: `🧠 Switched to **${modelLabel(session.model)}** — ${session.turnActive ? 'after the current message' : 'from the next message'}.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** Repo picked from the `/code new` select menu — creates the session channel. */
export async function handleRepoSelected(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  await interaction.deferUpdate();
  const fullName = interaction.values[0];

  try {
    const channel = await createSessionForRepo({
      guild: interaction.guild,
      user: interaction.user,
      fullName,
      sessionManager,
    });
    await interaction.editReply({
      content: `✅ Created ${channel} — cloning \`${fullName}\`...`,
      components: [buildOpenSessionRow(interaction.guildId, channel.id)],
    });
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content: `❌ Couldn't start a session: ${err.message}`.slice(0, 2000),
      components: [],
    });
  }
}

/**
 * Sends `text` as the next turn in `session` and posts the reply into
 * `channel`, including the post-reply buttons, or option buttons if
 * Claude's reply ended with a ```options block. Shared by plain messages
 * and option-button clicks so both go through identical handling.
 *
 * While the turn runs, the "Thinking..." message carries a Stop button and
 * is edited with a live list of what Claude is doing (throttled — see
 * PROGRESS_EDIT_INTERVAL_MS). Messages sent in the meantime are queued on
 * the session and run together as one follow-up turn afterwards.
 */
async function runTurn(session, channel, text, sessionManager) {
  session.turnActive = true;
  const thinking = await channel.send({ content: '🤔 Thinking...', components: [buildStopRow()] });

  // Snapshot the files before Claude touches them, for the Undo button.
  // Best-effort: if it fails, the turn still runs, just without Undo.
  // Chats have no repo (and no file edits), so no Undo.
  const turnId = crypto.randomUUID().slice(0, 8);
  const beforeTree = session.isChat
    ? null
    : await snapshotWorkingTree(session.dir).catch((err) => {
        console.error(`[session ${session.id}] snapshot before turn failed:`, err.message);
        return null;
      });
  const replyRow = () => (session.isChat ? buildChatReplyRow() : buildPostReplyRow());
  // Returns an Undo row if this turn changed any files (and remembers the
  // snapshot so the button can restore it), else null.
  const undoRowIfChanged = async () => {
    if (!beforeTree) return null;
    const afterTree = await snapshotWorkingTree(session.dir).catch(() => null);
    if (!afterTree || afterTree === beforeTree) return null;
    session.undoSnapshot = { turnId, tree: beforeTree };
    return buildUndoRow(turnId);
  };

  if (session.pendingNote) {
    text = `[${session.pendingNote}]\n\n${text}`;
    session.pendingNote = null;
  }

  // The account's 5-hour usage bar for the top of the end-of-turn message.
  // Fetched fresh since the turn just used some; capped so a slow usage
  // endpoint never holds up the reply.
  const usageLine = () =>
    Promise.race([
      getClaudeUsage({ fresh: true }).then(formatSessionUsageLine).catch(() => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), USAGE_LINE_TIMEOUT_MS)),
    ]);

  let toolCallCount = 0;
  const progress = [];
  let editTimer = null;
  let lastEditAt = 0;
  let finished = false;

  const scheduleProgressEdit = () => {
    if (editTimer || finished) return;
    const wait = Math.max(0, lastEditAt + PROGRESS_EDIT_INTERVAL_MS - Date.now());
    editTimer = setTimeout(() => {
      editTimer = null;
      if (finished) return;
      lastEditAt = Date.now();
      const lines = progress.slice(-PROGRESS_LINES_SHOWN);
      const earlier = progress.length - lines.length;
      const content = `🤔 Working...${earlier > 0 ? ` _(${earlier} earlier step${earlier === 1 ? '' : 's'})_` : ''}\n${lines.join('\n')}`;
      thinking.edit({ content: content.slice(0, 2000) }).catch(() => {});
    }, wait);
  };

  try {
    const { result, stopped } = await sessionManager.sendMessage(session, text, {
      onEvent: (event) => {
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type !== 'tool_use') continue;
            toolCallCount += 1;
            progress.push(describeToolUse(block, session.dir));
            scheduleProgressEdit();
          }
        }
      },
    });
    finished = true;
    clearTimeout(editTimer);
    const undoRow = await undoRowIfChanged();

    if (stopped) {
      const stoppedAt = `⏹️ Stopped${toolCallCount > 0 ? ` after ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}` : ''}.`;
      await thinking.edit({
        content: session.isChat
          ? stoppedAt
          : `${stoppedAt} Any file changes made so far are kept${undoRow ? ' — use Undo to roll them back' : ''}.`,
        components: [],
      });
      await channel.send({
        content: [await usageLine(), 'What next?'].filter(Boolean).join('\n'),
        components: [replyRow(), ...(undoRow ? [undoRow] : [])],
      });
      return;
    }
    if (!result) {
      await thinking.edit({ content: '❌ Claude Code did not return a result (check container logs).', components: [] });
      return;
    }
    if (result.subtype && result.subtype !== 'success') {
      await thinking.edit({
        content: `❌ Claude finished with an error: ${(result.result ?? result.subtype).slice(0, 1900)}`,
        components: undoRow ? [undoRow] : [],
      });
      return;
    }

    const { text: replyText, options } = parseOptionsBlock(result.result || '(no text response)');
    session.pendingOptions = options;

    const usagePromise = usageLine();
    const chunks = chunkMessage(replyText);
    await thinking.edit({ content: chunks[0], components: [] });
    for (const extra of chunks.slice(1)) {
      await channel.send(extra);
    }

    const stats = formatTurnStats(result, toolCallCount);
    const statsLine = stats ? `_(${stats} · session total ~$${session.totalCostUsd.toFixed(2)})_` : '';
    const usage = await usagePromise;
    const extraRows = undoRow ? [undoRow] : [];
    if (options) {
      await channel.send({
        content: [usage, `Pick one: ${statsLine}`.trim()].filter(Boolean).join('\n'),
        components: [...buildOptionsRows(options), ...extraRows],
      });
    } else {
      await channel.send({
        content: [usage, statsLine || 'What next?'].filter(Boolean).join('\n'),
        components: [replyRow(), ...extraRows],
      });
    }
  } catch (err) {
    console.error(err);
    await thinking.edit({ content: `❌ ${err.message}`.slice(0, 2000), components: [] }).catch(() => {});
  } finally {
    finished = true;
    clearTimeout(editTimer);
    session.turnActive = false;
  }

  // Anything sent while Claude was working goes in as one combined turn,
  // which is cheaper than replaying the whole conversation once per message.
  if (session.queuedMessages.length > 0 && !session.closed) {
    const queued = session.queuedMessages.splice(0);
    await channel.send(`📨 Sending ${queued.length} queued message${queued.length === 1 ? '' : 's'} to Claude...`);
    await runTurn(session, channel, queued.join('\n\n'), sessionManager);
  }
}

/** A plain message sent inside an active session channel. */
export async function handleSessionMessage(message, sessionManager) {
  const session = sessionManager.getByChannel(message.channelId);
  if (!session) return;
  if (message.author.bot) return;

  let text = message.content;
  if (message.attachments.size > 0) {
    try {
      const { paths, skipped } = await downloadAttachments(message, session.dir);
      if (paths.length > 0) {
        const refs = paths.map((p) => `- ${p}`).join('\n');
        text = `${text}\n\n[Attached file${paths.length > 1 ? 's' : ''}, read with the Read tool:]\n${refs}`;
      }
      if (skipped.length > 0) {
        await message.reply(
          `⚠️ Skipped ${skipped.map((n) => `\`${n}\``).join(', ')} — only images, text/log/code files and PDFs are supported, and big files are skipped.`,
        );
      }
    } catch (err) {
      console.error('Failed to download attachment(s):', err);
      await message.reply(`⚠️ Couldn't download an attachment: ${err.message}`);
    }
  }
  if (!text.trim()) return;

  if (session.turnActive) {
    session.queuedMessages.push(text);
    await message.reply("📥 Queued — I'll send this to Claude as soon as it finishes the current message.");
    return;
  }

  await runTurn(session, message.channel, text, sessionManager);
}

/** Stop button on the live "Thinking..." message — kills the in-flight turn (runTurn then edits that message). */
export async function handleStopButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session || !session.stop()) {
    await interaction.reply({ content: 'Nothing is running right now.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  const dropped = session.queuedMessages.splice(0).length;
  if (dropped > 0) {
    await interaction.followUp(`🗑️ Also dropped ${dropped} queued message${dropped === 1 ? '' : 's'}.`);
  }
}

/** Show Changes button — privately lists what Commit would include, with the full diff attached. */
export async function handleShowChangesButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (await rejectIfChat(interaction, session)) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { files, stat, patch } = await pendingChanges(session.git);
    if (!files) {
      await interaction.editReply('No changes since the last commit.');
      return;
    }
    const list = files.length > 1500 ? `${files.slice(0, 1500)}\n…` : files;
    await interaction.editReply({
      content:
        `**Changes Push Live would include**${stat ? ` — ${stat}` : ''}\n` +
        `\`\`\`\n${list}\n\`\`\`` +
        '_M = modified, A = new, D = deleted. Full diff attached._',
      files: [new AttachmentBuilder(Buffer.from(patch), { name: 'changes.diff' })],
    });
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Couldn't read changes: ${err.message}`.slice(0, 2000));
  }
}

/** Fresh Start button — clears Claude's conversation history (files are kept) so later messages cost less. */
export async function handleFreshStartButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working — try Fresh Start again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.resetConversation();
  if (session.isChat) {
    await interaction.reply(`🆕 ${interaction.user} started a new chat — Claude has forgotten everything above this line.\n${'─'.repeat(30)}`);
    return;
  }
  await interaction.reply(
    `🧹 ${interaction.user} started a fresh conversation. Claude has forgotten the chat so far, but all file changes are kept — ` +
      'your next message starts from scratch (and costs less).',
  );
}

/** Keep Alive button on the idle warning — resets the 4-hour idle countdown. */
export async function handleKeepAliveButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.update({ content: 'This session is already closed.', components: [] });
    return;
  }
  session.keepAlive();
  await interaction.update({ content: `✅ ${interaction.user} kept this session alive — the 4-hour idle timer has been reset.`, components: [] });
}

/** Posted into the session channel 15 minutes before the idle auto-close (wired up in index.js). */
export async function sendIdleWarning(channel, session) {
  let lossNote = '';
  if (session.isChat) {
    lossNote = ' The conversation will be lost.';
  } else {
    try {
      const status = await session.git.status();
      lossNote = status.isClean()
        ? " There are no uncommitted changes, so nothing will be lost."
        : ' **Uncommitted changes will be discarded** — click Push Live to keep them.';
    } catch {
      // Status is only for the note; the warning itself still matters.
    }
  }
  await channel.send({
    content: `⏰ This session has been idle for a while and will auto-close in 15 minutes.${lossNote}`,
    components: [buildIdleWarningRow()],
  });
}

/** `/code model` — switches the model for this session's future messages. */
export async function handleCodeModel(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: 'Run this inside an active Claude Code session channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const choice = interaction.options.getString('model', true);
  session.setModel(choice === 'default' ? null : choice);
  await interaction.reply(
    `🧠 ${interaction.user} switched this session to **${modelLabel(session.model)}**. ` +
      `${session.turnActive ? 'Takes effect after the current message.' : 'Takes effect from the next message.'}`,
  );
}

/**
 * Push Live — commits, opens a PR with a Claude-written title, and merges
 * it into the default branch. From a reply's row it collapses that row to a
 * disabled "Pushed Live ✓"; from the session panel it leaves the panel alone.
 */
export async function handleCommitButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (await rejectIfChat(interaction, session)) return;
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working on a newer message — try Push Live again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (session.pushing) {
    await interaction.reply({ content: '⏳ Already pushing live — hang on.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === PANEL_COMMIT_BUTTON_ID) {
    // From the session panel: leave the panel's buttons alone, just acknowledge.
    await interaction.reply(`🚀 ${interaction.user} is pushing live...`);
  } else {
    await interaction.update({ components: [buildPostReplyRow({ used: 'commit' })] });
  }

  session.pushing = true;
  try {
    const mergeStartedAt = Date.now();
    const outcome = await sessionManager.commitAndMerge(session);
    if (!outcome) {
      await interaction.followUp('Nothing to push — no changes since the last Push Live.');
      return;
    }
    await interaction.followUp({
      content: `✅ Pushed live: **${outcome.pr.title}**\n-# Merged ${outcome.pr.html_url} into \`${session.defaultBranch}\``,
      components: [buildRevertRow(outcome.pr.number)],
    });
    logEvent(
      interaction.guildId,
      `📦 ${interaction.user} committed on **${session.owner}/${session.repo}**: ${outcome.pr.html_url}`,
    );
    followDeploy(session, interaction.channel, { sha: outcome.merged.sha, since: mergeStartedAt });
  } catch (err) {
    console.error(err);
    await interaction.followUp(`❌ Push Live failed: ${err.message}`.slice(0, 2000));
  } finally {
    session.pushing = false;
  }
}

const DEPLOY_STATUS_TEXT = {
  queued: '🕐 queued',
  in_progress: '🔨 building and deploying...',
};

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/**
 * After a merge into the default branch, follows the Coolify deploy(s) of
 * that repo+branch and posts progress into `channel` (one message per app,
 * edited as it goes), plus the result to the log channel. Pass
 * `channel: null` when the session channel is about to be deleted — then
 * only the log channel hears about it. Fire-and-forget: never throws, and
 * silently does nothing if Coolify isn't configured or no app deploys
 * this repo.
 */
function followDeploy(session, channel, { sha, since }) {
  if (!coolify.isConfigured()) return;
  const { guildId, owner, repo, defaultBranch } = session;

  (async () => {
    const apps = await coolify.findApplications(owner, repo, defaultBranch);
    await Promise.all(
      apps.map(async (app) => {
        const name = `**${app.name}**`;
        const message = channel ? await channel.send(`🚀 Waiting for Coolify to deploy ${name}...`).catch(() => null) : null;
        let startedAt = null;

        const { status, deployment } = await coolify.watchDeployment(app, {
          sha,
          since,
          onStatus: async (s) => {
            if (s === 'in_progress' && !startedAt) startedAt = Date.now();
            if (DEPLOY_STATUS_TEXT[s]) await message?.edit(`🚀 ${name}: ${DEPLOY_STATUS_TEXT[s]}`).catch(() => {});
          },
        });

        let text;
        if (status === 'finished') {
          text = `✅ ${name} deployed${startedAt ? ` (took ${formatDuration(Date.now() - startedAt)})` : ''}.`;
        } else if (status === 'failed') {
          const tail = await coolify.deploymentLogTail(deployment.uuid);
          text = `❌ ${name} deploy **failed**. Check the deployment log in Coolify.` + (tail ? `\n\`\`\`\n${tail.slice(-1500)}\n\`\`\`` : '');
        } else if (status === 'cancelled-by-user') {
          text = `⚪ ${name} deploy was cancelled in Coolify.`;
        } else if (status === 'not-found') {
          text = `⚠️ No deploy of ${name} started within 3 minutes — is auto-deploy on for it in Coolify?`;
        } else {
          text = `⚠️ Stopped watching the ${name} deploy after 30 minutes — check Coolify.`;
        }
        await message?.edit(text.slice(0, 2000)).catch(() => {});
        if (status === 'finished' || status === 'failed') {
          logEvent(guildId, `${status === 'finished' ? '✅' : '❌'} Deploy of **${app.name}** (${owner}/${repo}) ${status === 'finished' ? 'finished' : 'failed'}.`);
        }
      }),
    );
  })().catch((err) => console.error(`[session ${session.id}] deploy follow failed:`, err));
}

/** Keep Going button on a reply — no-op besides collapsing this message's first row (an Undo row below it is kept). */
export async function handleKeepGoingButton(interaction) {
  await interaction.update({
    components: [buildPostReplyRow({ used: 'keep-going' }), ...interaction.message.components.slice(1).map((row) => row.toJSON())],
  });
}

/** Undo button under a reply — puts files back as they were before that reply. Only the latest file-changing reply can be undone. */
export async function handleUndoButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({ content: "⏳ Claude's still working — try Undo again once it replies.", flags: MessageFlags.Ephemeral });
    return;
  }
  const turnId = interaction.customId.slice(UNDO_BUTTON_PREFIX.length);
  if (session.undoSnapshot?.turnId !== turnId) {
    await interaction.reply({
      content: 'Only the most recent reply that changed files can be undone — and not after a Push Live.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  try {
    await restoreWorkingTree(session.dir, session.undoSnapshot.tree);
    session.undoSnapshot = null;
    // Claude's conversation still remembers making those edits — tell it on the next turn.
    session.pendingNote =
      'Note from the bot: the user clicked Undo, so every file change from your previous reply has been reverted on disk. ' +
      "Re-read any files before relying on what you think they contain.";
    const rows = interaction.message.components.map((row) =>
      row.components.some((c) => c.customId?.startsWith(UNDO_BUTTON_PREFIX)) ? buildUndoRow(turnId, { used: true }) : row.toJSON(),
    );
    await interaction.editReply({ components: rows });
    await interaction.followUp(`↩️ ${interaction.user} undid the file changes from that reply.`);
  } catch (err) {
    console.error(err);
    await interaction.followUp({ content: `❌ Undo failed: ${err.message}`.slice(0, 2000), flags: MessageFlags.Ephemeral });
  }
}

/** Revert button on a "Committed and merged" message — asks to confirm (it changes the live default branch). */
export async function handleRevertButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  const pullNumber = Number(interaction.customId.slice(REVERT_BUTTON_PREFIX.length));
  await interaction.reply({
    content:
      `⏪ This opens a PR that reverts #${pullNumber} on \`${session.defaultBranch}\` and merges it straight away` +
      `${coolify.isConfigured() ? ' — Coolify will redeploy without that change' : ''}. Continue?`,
    components: [buildRevertConfirmRow(pullNumber)],
    flags: MessageFlags.Ephemeral,
  });
}

/** Confirm on the revert prompt — reverts the merged PR on GitHub and follows the resulting deploy. */
export async function handleRevertConfirmButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.update({ content: 'This session is closed.', components: [] });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({ content: "⏳ Claude's still working — try again once it replies.", flags: MessageFlags.Ephemeral });
    return;
  }
  const pullNumber = Number(interaction.customId.slice(REVERT_CONFIRM_PREFIX.length));

  await interaction.update({ content: `⏪ Reverting #${pullNumber}...`, components: [] });
  try {
    const mergeStartedAt = Date.now();
    const { revertPr, merged, synced } = await sessionManager.revertMergedPullRequest(session, pullNumber);
    await interaction.editReply({ content: `✅ Reverted #${pullNumber}.` });
    await interaction.channel.send(
      `⏪ ${interaction.user} reverted #${pullNumber} — merged **${revertPr.url}** into \`${session.defaultBranch}\`.` +
        (synced
          ? ' The session has moved onto the reverted code.'
          : '\n⚠️ This session has uncommitted changes, so its files were left as they are — they still include the reverted change. ' +
            'Push Live or Exit, then start a new session to work from the reverted code.'),
    );
    logEvent(interaction.guildId, `⏪ ${interaction.user} reverted #${pullNumber} on **${session.owner}/${session.repo}**: ${revertPr.url}`);
    followDeploy(session, interaction.channel, { sha: merged.sha, since: mergeStartedAt });
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content:
        `❌ Couldn't revert #${pullNumber}: ${err.message}`.slice(0, 1800) +
        "\nIf later changes touched the same code, GitHub can't revert it automatically — use the Revert button on the PR on GitHub instead.",
    });
  }
}

function refreshRow(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${customId}${STATUS_REFRESH_SUFFIX}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Fills in a status reply deferred by deferStatus — a new private reply,
 * or the same message again when it came from that reply's own Refresh
 * button. Shared by the sessions and Coolify status views.
 */
async function sendStatusReply(interaction, baseCustomId, content, extraRows = []) {
  await interaction.editReply({
    content: `${content.slice(0, 1900)}\n-# Updated <t:${Math.floor(Date.now() / 1000)}:R>`,
    components: [...extraRows.filter(Boolean), refreshRow(baseCustomId)],
    allowedMentions: { parse: [] },
  });
}

/**
 * `/code status`, or the Open Sessions button under the repo picker — every
 * open session with its repo, owner, idle time, model and cost so far.
 */
export async function handleCodeStatus(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);
  await deferStatus(interaction);

  const sessions = sessionManager.listSessions().filter((s) => s.guildId === interaction.guildId);
  if (sessions.length === 0) {
    await sendStatusReply(interaction, SESSIONS_STATUS_BUTTON_ID, '### 📋 No open sessions right now');
    return;
  }
  const now = Date.now();
  // Same layout as Server Status: icon + name, then details in small grey subtext, boxed by divider lines.
  const item = (s) => {
    const idleMs = now - s.lastActivityAt;
    let icon = '🟢';
    let activity = `Last active <t:${Math.floor(s.lastActivityAt / 1000)}:R>`;
    if (s.turnActive) {
      icon = '⚙️';
      activity = 'Working on a message now';
    } else if (idleMs >= IDLE_WARNING_AT_MS) {
      icon = '⏰';
      activity += ' — closes soon if left idle';
    } else if (idleMs >= 60 * 60 * 1000) {
      icon = '💤';
    }
    return [
      `${icon} **${s.label}**`,
      `-# <#${s.channelId}> · <@${s.ownerId}>`,
      `-# ${activity}`,
      `-# Model: ${modelLabel(s.model)} · Cost so far ~$${s.totalCostUsd.toFixed(2)}`,
    ].join('\n');
  };
  const sorted = sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const total = sessions.reduce((sum, s) => sum + s.totalCostUsd, 0);
  await sendStatusReply(
    interaction,
    SESSIONS_STATUS_BUTTON_ID,
    `### 📋 ${sessions.length} open session${sessions.length === 1 ? '' : 's'} · ~$${total.toFixed(2)} total\n` +
      `${STATUS_DIVIDER}\n${sorted.map(item).join(`\n${STATUS_DIVIDER}\n`)}\n${STATUS_DIVIDER}`,
  );
}

// Matches the idle warning in session.js (4h auto-close, warned 15 minutes before).
const IDLE_WARNING_AT_MS = (4 * 60 - 15) * 60 * 1000;

/** Refresh buttons update their own message; everything else gets a new private reply. */
async function deferStatus(interaction) {
  if (interaction.isButton() && interaction.customId.endsWith(STATUS_REFRESH_SUFFIX)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

/**
 * Server Status button under the repo picker — everything Coolify runs,
 * with anything stopped, unhealthy or restarting listed first.
 */
export async function handleCoolifyStatus(interaction) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);
  if (!coolify.isConfigured()) {
    const missing = [!config.coolify.url && '`COOLIFY_URL`', !config.coolify.apiToken && '`COOLIFY_API_TOKEN`'].filter(Boolean);
    await interaction.reply({
      content:
        `🖥️ Server Status needs Coolify set up — the bot can't see ${missing.join(' or ')}.\n` +
        'In Coolify: the bot app → **Environment Variables** → add ' +
        '`COOLIFY_URL=http://coolify:8080` and `COOLIFY_API_TOKEN=<token>` ' +
        '(make one under **Keys & Tokens → API tokens**), then **Redeploy**.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await deferStatus(interaction);

  try {
    const resources = await coolify.listResources();
    if (resources.length === 0) {
      await sendStatusReply(interaction, COOLIFY_STATUS_BUTTON_ID, "Coolify didn't return anything — check the API token's permissions.");
      return;
    }
    const items = decorateResources(resources);
    const byName = (a, b) => a.label.localeCompare(b.label);
    const problems = items.filter((r) => (r.status && r.statusIcon !== '🟢') || r.deployFailed).sort(byName);
    const fine = items.filter((r) => !problems.includes(r));
    // Lines above, between and below the items, so each one sits in its own box.
    const list = (group) => `${STATUS_DIVIDER}\n${group.map(describeResource).join(`\n${STATUS_DIVIDER}\n`)}\n${STATUS_DIVIDER}`;

    const sections = [
      problems.length > 0
        ? `### ⚠️ ${problems.length} need${problems.length === 1 ? 's' : ''} attention\n${list(problems)}`
        : '### ✅ Everything is running',
    ];
    for (const [kind, heading] of [['app', 'Apps'], ['database', 'Databases'], ['service', 'Services']]) {
      const group = fine.filter((r) => r.kind === kind).sort(byName);
      if (group.length > 0) sections.push(`**${heading}**\n${list(group)}`);
    }
    await sendStatusReply(interaction, COOLIFY_STATUS_BUTTON_ID, sections.join('\n\n'), [buildAppSelectRow(items)]);
  } catch (err) {
    console.error('Coolify status failed:', err);
    await sendStatusReply(interaction, COOLIFY_STATUS_BUTTON_ID, `❌ Couldn't reach Coolify: ${err.message}`);
  }
}

const INIT_PROMPT = `Create a CLAUDE.md file at the repo root (or improve the existing one) — project notes that future Claude Code sessions will read at the start instead of re-exploring the codebase. Base it on actually reading the code; don't guess or invent commands. Cover, concisely:
- What the project is and does, in a sentence or two
- Tech stack and key dependencies
- How to install, run, test and build (exact commands)
- Project layout: the key directories/files and what lives where
- Conventions (code style, naming, patterns to follow) and gotchas/pitfalls
- How it's deployed, if that's visible from the repo
Keep it under about 100 lines and skimmable. Don't commit — the user saves it with the Push Live button.`;

/** `/code init` — asks Claude to write (or refresh) the repo's CLAUDE.md project notes. */
export async function handleCodeInit(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'Run this inside an active Claude Code session channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (await rejectIfChat(interaction, session)) return;
  if (session.turnActive) {
    await interaction.reply({ content: "⏳ Claude's still working — try again once it replies.", flags: MessageFlags.Ephemeral });
    return;
  }

  const exists = fs.existsSync(path.join(session.dir, 'CLAUDE.md'));
  await interaction.reply(
    `📝 ${interaction.user} asked Claude to ${exists ? 'update' : 'write'} \`CLAUDE.md\` project notes. ` +
      'Click **Push Live** afterwards to save them to the repo.',
  );
  await runTurn(session, interaction.channel, INIT_PROMPT, sessionManager);
}

/**
 * Exit button — shown on every reply (not just the newest), and stays
 * live even after Commit/Keep Going is used on that message. Closes the
 * session, discarding anything not already committed. Works from any
 * message's row since they all reference the same underlying session.
 */
export async function handleExitButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'This session is already closed.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working on the previous message — try Exit again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({ components: [] });
  await closeWithoutCommitting(interaction.channel, session, sessionManager);
}

/** Shared by the inline Exit button and the /code close Exit button. */
async function closeWithoutCommitting(channel, session, sessionManager) {
  if (!session.isChat) await channel.send('👋 Closing without committing...');
  await sessionManager.close(session);
  await channel.send(
    session.isChat
      ? '👋 Chat closed. This channel will be removed shortly.'
      : 'Closed — nothing was committed. This channel will be removed shortly.',
  );
  await deleteChannelSoon(channel);
}

/** Click on one of the multiple-choice option buttons rendered from a ```options block. */
export async function handleOptionButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({ content: '⏳ Still working on the previous message.', flags: MessageFlags.Ephemeral });
    return;
  }

  const index = Number(interaction.customId.slice(OPTION_BUTTON_PREFIX.length));
  const label = session.pendingOptions?.[index];
  if (label === undefined) {
    await interaction.reply({
      content: "That option isn't valid anymore (a newer message replaced it).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.pendingOptions = null;
  await interaction.update({ content: `✅ You picked: **${label}**`, components: [] });
  await interaction.channel.send(`> ${label}`);
  await runTurn(session, interaction.channel, label, sessionManager);
}

/** `/code close` — must be run inside an active session channel; asks Push or Exit. */
export async function handleCodeClose(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: 'This is not an active Claude Code session channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Nothing to push in a chat, so skip the Push / Exit question.
  if (session.isChat) {
    if (session.turnActive) {
      await interaction.reply({ content: "⏳ Claude's still replying — try again once it's done.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(`👋 ${interaction.user} closed this chat.`);
    await closeWithoutCommitting(interaction.channel, session, sessionManager);
    return;
  }

  await interaction.reply({
    content:
      'Push any pending changes (commit + merge into the default branch) before closing, or exit without committing?',
    components: [buildClosePromptRow()],
  });
}

async function deleteChannelSoon(channel) {
  setTimeout(() => {
    channel.delete().catch((err) => console.error('Failed to delete session channel:', err));
  }, 5000);
}

/** Push button from the /code close prompt — commits+merges, then closes. */
export async function handleClosePushButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.update({ content: 'This session is already closed.', components: [] });
    return;
  }
  if (await rejectIfChat(interaction, session)) return;
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working on a message — try again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (session.pushing) {
    await interaction.reply({ content: '⏳ Already pushing live — hang on.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.update({ content: '🚀 Pushing live and closing...', components: [] });
  session.pushing = true;
  try {
    const mergeStartedAt = Date.now();
    const outcome = await sessionManager.commitAndMerge(session);
    if (outcome) {
      logEvent(
        interaction.guildId,
        `📦 ${interaction.user} committed on **${session.owner}/${session.repo}**: ${outcome.pr.html_url}`,
      );
      // The channel is deleted shortly, so the deploy result only goes to the log channel.
      followDeploy(session, null, { sha: outcome.merged.sha, since: mergeStartedAt });
    }
    await sessionManager.close(session, 'push');

    await interaction.channel.send(
      outcome
        ? `✅ Pushed live: **${outcome.pr.title}** (${outcome.pr.html_url}). This channel will be removed shortly.`
        : '✅ Closed — nothing to commit. This channel will be removed shortly.',
    );
    await deleteChannelSoon(interaction.channel);
  } catch (err) {
    console.error(err);
    await interaction.channel.send(`❌ Failed to close session: ${err.message}`.slice(0, 2000));
  } finally {
    session.pushing = false;
  }
}

/** Exit button from the /code close prompt — closes without committing. */
export async function handleCloseExitButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.update({ content: 'This session is already closed.', components: [] });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working on a message — try again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({ content: '👋 Closing...', components: [] });
  await closeWithoutCommitting(interaction.channel, session, sessionManager);
}

export {
  REPO_SELECT_ID,
  COMMIT_BUTTON_ID,
  KEEP_GOING_BUTTON_ID,
  EXIT_BUTTON_ID,
  OPTION_BUTTON_PREFIX,
  CLOSE_PUSH_BUTTON_ID,
  CLOSE_EXIT_BUTTON_ID,
  STOP_BUTTON_ID,
  SHOW_CHANGES_BUTTON_ID,
  FRESH_START_BUTTON_ID,
  KEEP_ALIVE_BUTTON_ID,
  UNDO_BUTTON_PREFIX,
  REVERT_BUTTON_PREFIX,
  REVERT_CONFIRM_PREFIX,
  SESSIONS_STATUS_BUTTON_ID,
  COOLIFY_STATUS_BUTTON_ID,
  PANEL_MODEL_SELECT_ID,
  PANEL_COMMIT_BUTTON_ID,
  PANEL_CLOSE_BUTTON_ID,
  PANEL_INIT_BUTTON_ID,
  NEW_CHAT_CHANNEL_BUTTON_ID,
};
