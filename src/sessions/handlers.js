import { AttachmentBuilder, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { buildRepoPickerReply, REPO_SELECT_ID } from './repo-picker.js';
import { createSessionChannel } from './channel.js';
import {
  buildPostReplyRow,
  buildOptionsRows,
  buildClosePromptRow,
  buildOpenSessionRow,
  buildStopRow,
  buildIdleWarningRow,
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
} from './reply.js';
import { parseRepoSlug } from '../github.js';
import { pendingChanges } from '../repo.js';
import { downloadAttachments } from './attachments.js';
import { logEvent } from '../log-channel.js';

// Discord rate-limits message edits (roughly 5 per 5s per channel), so the
// live progress line is batched to at most one edit per this interval.
const PROGRESS_EDIT_INTERVAL_MS = 2000;
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
    sessionId: id,
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

  await channel.send(
    `👋 Session started for **${fullName}** on branch \`${session.branchName}\`.\n` +
      `Just chat here — send a message describing what you want changed. ` +
      `Use the **Commit** button after a reply to commit what's changed so far and merge it straight into ` +
      `\`${session.defaultBranch}\` (a PR is opened and auto-merged, so it's still reviewable on GitHub afterward). ` +
      `Run \`/code close\` when you're done — it'll ask whether to commit first or just exit.\n` +
      `Idle for 4 hours with nothing committed will auto-close and discard pending changes (you'll get a warning 15 minutes before).\n` +
      `Model: **${modelLabel(session.model)}** — change it with \`/code model\`. You can attach images, text/log/code files and PDFs.`,
  );

  logEvent(guild.id, `🟢 ${user} opened a session on **${fullName}**: ${channel}`);

  return channel;
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

    if (stopped) {
      await thinking.edit({
        content: `⏹️ Stopped${toolCallCount > 0 ? ` after ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}` : ''}. Any file changes made so far are kept.`,
        components: [],
      });
      await channel.send({ content: 'What next?', components: [buildPostReplyRow()] });
      return;
    }
    if (!result) {
      await thinking.edit({ content: '❌ Claude Code did not return a result (check container logs).', components: [] });
      return;
    }
    if (result.subtype && result.subtype !== 'success') {
      await thinking.edit({
        content: `❌ Claude finished with an error: ${(result.result ?? result.subtype).slice(0, 1900)}`,
        components: [],
      });
      return;
    }

    const { text: replyText, options } = parseOptionsBlock(result.result || '(no text response)');
    session.pendingOptions = options;

    const chunks = chunkMessage(replyText);
    await thinking.edit({ content: chunks[0], components: [] });
    for (const extra of chunks.slice(1)) {
      await channel.send(extra);
    }

    const stats = formatTurnStats(result, toolCallCount);
    const statsLine = stats ? `_(${stats} · session total ~$${session.totalCostUsd.toFixed(2)})_` : '';
    if (options) {
      await channel.send({
        content: `Pick one: ${statsLine}`.trim(),
        components: buildOptionsRows(options),
      });
    } else {
      await channel.send({
        content: statsLine || 'What next?',
        components: [buildPostReplyRow()],
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
        `**Changes Commit would include**${stat ? ` — ${stat}` : ''}\n` +
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
  try {
    const status = await session.git.status();
    lossNote = status.isClean()
      ? " There are no uncommitted changes, so nothing will be lost."
      : ' **Uncommitted changes will be discarded** — click Commit on a recent reply to keep them.';
  } catch {
    // Status is only for the note; the warning itself still matters.
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
 * Commit button on a reply — commits, opens a PR, and merges it into the
 * default branch. Collapses this message's row to a disabled "Committed"
 * button (keeping a fresh, still-live Exit button) so it can't be clicked
 * again from here.
 */
export async function handleCommitButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working on a newer message — try Commit again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({ components: [buildPostReplyRow({ used: 'commit' })] });
  try {
    const outcome = await sessionManager.commitAndMerge(session);
    await interaction.followUp(
      outcome
        ? `✅ Committed and merged **${outcome.pr.html_url}** into \`${session.defaultBranch}\`.`
        : 'Nothing to commit — no changes since last commit.',
    );
    if (outcome) {
      logEvent(
        interaction.guildId,
        `📦 ${interaction.user} committed on **${session.owner}/${session.repo}**: ${outcome.pr.html_url}`,
      );
    }
  } catch (err) {
    console.error(err);
    await interaction.followUp(`❌ Commit failed: ${err.message}`.slice(0, 2000));
  }
}

/** Keep Going button on a reply — no-op besides collapsing this message's row. */
export async function handleKeepGoingButton(interaction) {
  await interaction.update({ components: [buildPostReplyRow({ used: 'keep-going' })] });
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
  await channel.send('👋 Closing without committing...');
  await sessionManager.close(session);
  await channel.send('Closed — nothing was committed. This channel will be removed shortly.');
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
  if (session.turnActive) {
    await interaction.reply({
      content: "⏳ Claude's still working on a message — try again once it replies.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({ content: '📦 Committing and closing...', components: [] });
  try {
    const outcome = await sessionManager.commitAndMerge(session, `Claude Code session ${session.id} (final)`);
    if (outcome) {
      logEvent(
        interaction.guildId,
        `📦 ${interaction.user} committed on **${session.owner}/${session.repo}**: ${outcome.pr.html_url}`,
      );
    }
    await sessionManager.close(session, 'push');

    await interaction.channel.send(
      outcome
        ? `✅ Committed and merged **${outcome.pr.html_url}**. This channel will be removed shortly.`
        : '✅ Closed — nothing to commit. This channel will be removed shortly.',
    );
    await deleteChannelSoon(interaction.channel);
  } catch (err) {
    console.error(err);
    await interaction.channel.send(`❌ Failed to close session: ${err.message}`.slice(0, 2000));
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
};
