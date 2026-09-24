import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { buildRepoPickerReply, REPO_SELECT_ID } from './repo-picker.js';
import { createSessionChannel } from './channel.js';
import {
  buildPostReplyRow,
  buildOptionsRows,
  buildClosePromptRow,
  buildOpenSessionRow,
  buildBashApprovalRow,
  chunkMessage,
  parseOptionsBlock,
  looksLikeBashUnavailableClaim,
  COMMIT_BUTTON_ID,
  KEEP_GOING_BUTTON_ID,
  EXIT_BUTTON_ID,
  OPTION_BUTTON_PREFIX,
  CLOSE_PUSH_BUTTON_ID,
  CLOSE_EXIT_BUTTON_ID,
  APPROVE_BASH_BUTTON_ID,
  DENY_BASH_BUTTON_ID,
} from './reply.js';
import { parseRepoSlug } from '../github.js';
import { downloadImageAttachments } from './attachments.js';
import { logEvent } from '../log-channel.js';

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
      `Idle for 4 hours with nothing committed will auto-close and discard pending changes.`,
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
 * `channel`, including Commit/Keep Going/Exit buttons, option buttons if
 * Claude's reply ended with a ```options block, or an Approve/Deny prompt
 * if Claude was denied a tool (currently always Bash — see session.js).
 * Shared by plain messages, option-button clicks, and Bash approval
 * re-runs so all three go through identical handling. `allowBash: true`
 * is passed through for the one-time re-run after an approval.
 */
async function runTurn(session, channel, text, sessionManager, { allowBash = false } = {}) {
  const thinking = await channel.send('🤔 Thinking...');
  let toolCallCount = 0;

  try {
    const { result, permissionDenials } = await sessionManager.sendMessage(session, text, {
      allowBash,
      onEvent: (event) => {
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') toolCallCount += 1;
          }
        }
      },
    });

    if (!result) {
      await thinking.edit('❌ Claude Code did not return a result (check container logs).');
      return;
    }
    if (result.subtype && result.subtype !== 'success') {
      await thinking.edit(`❌ Claude finished with an error: ${(result.result ?? '').slice(0, 1900)}`);
      return;
    }

    const { text: replyText, options } = parseOptionsBlock(result.result || '(no text response)');
    session.pendingOptions = options;

    const chunks = chunkMessage(replyText);
    await thinking.edit(chunks[0]);
    for (const extra of chunks.slice(1)) {
      await channel.send(extra);
    }

    // A denial takes priority over the options/normal-reply row — Claude's
    // reply text in this case is almost always just "I can't do that",
    // not a real answer, so the actionable thing is the approval prompt.
    // Note: the real denial (see session.js) doesn't carry the specific
    // command Claude wanted to run, only "Bash isn't enabled" — so this
    // can't show the exact command, just that Bash was needed.
    //
    // Second, independent detection path: Claude sometimes asserts it
    // can't use Bash in prose without ever attempting the tool call, so no
    // permissionDenials entry exists (confirmed recurring live even with
    // the system prompt telling it to always try first — that instruction
    // alone isn't 100% reliable). Catch that pattern in the reply text and
    // offer the same Approve/Deny prompt anyway.
    const claimedUnavailable = permissionDenials.length === 0 && looksLikeBashUnavailableClaim(replyText);
    if (permissionDenials.length > 0 || claimedUnavailable) {
      session.pendingApprovalText = text;
      await channel.send({
        content: '🔒 Claude wants to use a shell command (Bash), which is disabled by default.\n\nApprove it for this one attempt?',
        components: [buildBashApprovalRow()],
      });
      return;
    }

    const suffix = toolCallCount > 0 ? ` _(${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'})_` : '';
    if (options) {
      await channel.send({
        content: `Pick one:${suffix}`,
        components: buildOptionsRows(options),
      });
    } else {
      await channel.send({
        content: (suffix.trim() || 'What next?'),
        components: [buildPostReplyRow()],
      });
    }
  } catch (err) {
    console.error(err);
    await thinking.edit(`❌ ${err.message}`.slice(0, 2000));
  }
}

/** A plain message sent inside an active session channel. */
export async function handleSessionMessage(message, sessionManager) {
  const session = sessionManager.getByChannel(message.channelId);
  if (!session) return;
  if (message.author.bot) return;

  if (session.busy) {
    await message.reply('⏳ Still working on the previous message — wait for that to finish.');
    return;
  }

  let text = message.content;
  if (message.attachments.size > 0) {
    try {
      const imagePaths = await downloadImageAttachments(message, session.dir);
      if (imagePaths.length > 0) {
        const refs = imagePaths.map((p) => `- ${p}`).join('\n');
        text = `${text}\n\n[Attached image${imagePaths.length > 1 ? 's' : ''}, read with the Read tool:]\n${refs}`;
      }
    } catch (err) {
      console.error('Failed to download attachment(s):', err);
      await message.reply(`⚠️ Couldn't download an attachment: ${err.message}`);
    }
  }

  await runTurn(session, message.channel, text, sessionManager);
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
  if (session.busy) {
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
  if (session.busy) {
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

/**
 * Approve button on a Bash-denial prompt — re-sends the same message with
 * Bash allowed for that one re-run (see session.js's sendMessage for why
 * this unlocks Bash entirely rather than just the specific denied
 * command).
 */
export async function handleApproveBashButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.busy) {
    await interaction.reply({ content: '⏳ Still working on another message.', flags: MessageFlags.Ephemeral });
    return;
  }
  const text = session.pendingApprovalText;
  if (!text) {
    await interaction.reply({
      content: "That approval isn't valid anymore (a newer message replaced it).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.pendingApprovalText = null;
  await interaction.update({ content: `${interaction.message.content}\n\n✅ Approved.`, components: [] });
  logEvent(interaction.guildId, `🔓 ${interaction.user} approved a Bash request on **${session.owner}/${session.repo}**`);
  await runTurn(session, interaction.channel, text, sessionManager, { allowBash: true });
}

/** Deny button on a Bash-denial prompt — just lets Claude's "I can't do that" reply stand. */
export async function handleDenyBashButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (session) session.pendingApprovalText = null;
  await interaction.update({ content: `${interaction.message.content}\n\n🚫 Denied.`, components: [] });
  if (session) {
    logEvent(interaction.guildId, `🚫 ${interaction.user} denied a Bash request on **${session.owner}/${session.repo}**`);
  }
}

/** Click on one of the multiple-choice option buttons rendered from a ```options block. */
export async function handleOptionButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.busy) {
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
  if (session.busy) {
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
  if (session.busy) {
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
  APPROVE_BASH_BUTTON_ID,
  DENY_BASH_BUTTON_ID,
};
