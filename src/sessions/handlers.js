import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { buildRepoPickerReply, REPO_SELECT_ID } from './repo-picker.js';
import { createSessionChannel } from './channel.js';
import { buildPostReplyRow, chunkMessage, PUSH_BUTTON_ID, KEEP_GOING_BUTTON_ID } from './reply.js';
import { parseRepoSlug } from '../github.js';

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

/** Repo picked from the `/code new` select menu — creates the session channel. */
export async function handleRepoSelected(interaction, sessionManager) {
  if (!hasAccess(interaction)) return replyNoAccess(interaction);

  await interaction.deferUpdate();
  const fullName = interaction.values[0];
  const { owner, name } = parseRepoSlug(fullName);

  try {
    const id = sessionManager.generateSessionId();
    const channel = await createSessionChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      allowedRoleId: config.discord.allowedRoleId,
      repoFullName: fullName,
      sessionId: id,
    });

    await interaction.editReply({
      content: `✅ Created ${channel} — cloning \`${fullName}\`...`,
      components: [],
    });

    const session = await sessionManager.createSession({
      id,
      channelId: channel.id,
      ownerId: interaction.user.id,
      owner,
      repo: name,
      base: undefined,
    });

    await channel.send(
      `👋 Session started for **${fullName}** on branch \`${session.branchName}\`.\n` +
        `Just chat here — send a message describing what you want changed. ` +
        `Use the **Push** button after a reply to commit+push what's changed so far, ` +
        `or run \`/code close\` when you're done to push, open a PR, and remove this channel.\n` +
        `Idle for 4 hours with nothing pushed will auto-close and discard pending changes.`,
    );
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content: `❌ Couldn't start a session: ${err.message}`.slice(0, 2000),
      components: [],
    });
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

  const thinking = await message.channel.send('🤔 Thinking...');
  let toolCallCount = 0;

  try {
    const result = await sessionManager.sendMessage(session, message.content, {
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

    const replyText = result.result || '(no text response)';
    const chunks = chunkMessage(replyText);
    await thinking.edit(chunks[0]);
    for (const extra of chunks.slice(1)) {
      await message.channel.send(extra);
    }

    const suffix = toolCallCount > 0 ? `\n\n_(${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'})_` : '';
    await message.channel.send({
      content: suffix ? suffix.trim() : 'What next?',
      components: [buildPostReplyRow()],
    });
  } catch (err) {
    console.error(err);
    await thinking.edit(`❌ ${err.message}`.slice(0, 2000));
  }
}

export async function handlePushButton(interaction, sessionManager) {
  const session = sessionManager.getByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  try {
    const pushed = await sessionManager.push(session);
    await interaction.followUp(
      pushed ? `📦 Pushed to \`${session.branchName}\`.` : 'Nothing to push — no changes since last push.',
    );
  } catch (err) {
    console.error(err);
    await interaction.followUp(`❌ Push failed: ${err.message}`.slice(0, 2000));
  }
}

export async function handleKeepGoingButton(interaction) {
  await interaction.deferUpdate();
  // No-op: just acknowledges the button so it stops showing "interaction failed".
}

/** `/code close` — must be run inside an active session channel. */
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

  await interaction.deferReply();
  try {
    await sessionManager.push(session, `Claude Code session ${session.id} (final)`);
    const { pr } = await sessionManager.close(session);

    if (pr) {
      await interaction.editReply(`✅ Opened **${pr.html_url}**. This channel will be removed shortly.`);
    } else {
      await interaction.editReply('✅ Closed — no changes were pushed, so no PR was opened. This channel will be removed shortly.');
    }

    setTimeout(() => {
      interaction.channel.delete().catch((err) => console.error('Failed to delete session channel:', err));
    }, 5000);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`❌ Failed to close session: ${err.message}`.slice(0, 2000));
  }
}

export { REPO_SELECT_ID, PUSH_BUTTON_ID, KEEP_GOING_BUTTON_ID };
