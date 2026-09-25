import crypto from 'node:crypto';
import fs from 'node:fs';
import simpleGit from 'simple-git';
import {
  prepareRepo,
  commitAndPush,
  discardPendingChanges,
  cleanupRepoDir,
  rebranchFromDefault,
  isWorkingTreeClean,
} from '../repo.js';
import { openPullRequest, mergePullRequest, deleteBranch, openRevertPullRequest } from '../github.js';
import { Session } from './session.js';
import { writePullRequestSummary } from './pr-writer.js';
import { loadSessionsState, saveSessionsState } from './store.js';
import { cleanupUploadsDir } from './attachments.js';
import { logEvent } from '../log-channel.js';

/**
 * Tracks all active per-channel Claude Code chat sessions and owns their
 * full lifecycle: create -> message -> push -> close/expire.
 *
 * Session metadata is persisted to disk (see store.js) so sessions survive
 * a container restart — each Discord message spawns a fresh
 * `claude --resume` process anyway (see Session), so there's no in-memory
 * process to lose; we just need to remember which channels map to which
 * repo/branch/Claude conversation.
 */
export class SessionManager {
  constructor() {
    /** @type {Map<string, Session>} keyed by Discord channel id */
    this.sessionsByChannel = new Map();
  }

  /**
   * Reloads sessions persisted from a previous run. Returns the restored
   * sessions so the caller can, e.g., post a "session restored" notice in
   * each channel.
   */
  restore() {
    const saved = loadSessionsState();
    const restored = [];
    let anyDropped = false;
    for (const data of saved) {
      if (!fs.existsSync(data.dir)) {
        console.warn(`[session ${data.id}] working directory ${data.dir} is gone, dropping from state.`);
        anyDropped = true;
        continue;
      }
      const git = simpleGit(data.dir);
      const session = new Session({ ...data, git });
      this._wire(session);
      this.sessionsByChannel.set(session.channelId, session);
      restored.push(session);
    }
    if (anyDropped) this._persist();
    return restored;
  }

  _wire(session) {
    session._onIdleExpire = (s) => this._handleIdleExpire(s);
    session._onIdleWarning = (s) => this.onIdleWarning?.(s);
    session._onChange = () => this._persist();
  }

  _persist() {
    saveSessionsState(Array.from(this.sessionsByChannel.values()).map((s) => s.toJSON()));
  }

  getByChannel(channelId) {
    return this.sessionsByChannel.get(channelId);
  }

  listSessions() {
    return Array.from(this.sessionsByChannel.values());
  }

  generateSessionId() {
    return crypto.randomUUID().slice(0, 8);
  }

  async createSession({ id: providedId, channelId, guildId, ownerId, owner, repo, base }) {
    const id = providedId || crypto.randomUUID().slice(0, 8);
    const branchSuffix = `session-${id}`;

    const { git, dir, defaultBranch, branchName } = await prepareRepo({
      owner,
      name: repo,
      base,
      branchSuffix,
      workDirName: id,
    });

    const session = new Session({
      id,
      channelId,
      guildId,
      ownerId,
      owner,
      repo,
      dir,
      git,
      branchName,
      defaultBranch,
    });
    this._wire(session);

    this.sessionsByChannel.set(channelId, session);
    this._persist();
    return session;
  }

  /** Sends a chat message into the session, resuming its Claude conversation. */
  async sendMessage(session, text, opts) {
    return session.sendMessage(text, opts);
  }

  /**
   * Commits + pushes everything changed in the session's working directory
   * since the last push, opens a PR, and immediately merges it into the
   * default branch (squash) so it reaches `master`/`main` — and, via
   * Coolify's existing auto-deploy-on-push, goes live. Returns null if
   * there was nothing to commit.
   *
   * After merging, the session's working directory is moved onto a fresh
   * branch off the now-updated default branch, so a later Commit click
   * gets its own branch/PR rather than reusing one GitHub has already
   * merged.
   */
  async commitAndMerge(session, message) {
    // A descriptive title/summary written by Claude from the diff (see
    // pr-writer.js); falls back to the generic title if that fails.
    const summary = message ? null : await writePullRequestSummary(session).catch(() => null);
    if (summary?.costUsd) {
      session.totalCostUsd += summary.costUsd;
    }
    const commitMessage = message || summary?.title || `Claude Code session ${session.id}`;
    const { pushed } = await commitAndPush(session.git, session.branchName, commitMessage);
    if (!pushed) return null;

    session.hasPushedAnything = true;

    const footer = `Pushed live from an interactive Claude Code Discord session.\n\nBranch: \`${session.branchName}\``;
    const pr = await openPullRequest({
      owner: session.owner,
      repo: session.repo,
      base: session.defaultBranch,
      head: session.branchName,
      title: commitMessage,
      body: summary?.body ? `${summary.body}\n\n---\n${footer}` : footer,
    });

    const merged = await mergePullRequest({
      owner: session.owner,
      repo: session.repo,
      pullNumber: pr.number,
    });

    await deleteBranch({ owner: session.owner, repo: session.repo, branch: session.branchName });

    session.undoSnapshot = null; // relative to the old branch — restoring it now would fight the merge
    await this._rebranch(session);
    return { pr, merged };
  }

  /** Moves the session onto a fresh branch off the (freshly pulled) default branch. */
  async _rebranch(session) {
    session.commitCount += 1;
    const nextBranch = `claude/session-${session.id}-${session.commitCount}`;
    await rebranchFromDefault(session.git, session.defaultBranch, nextBranch);
    session.branchName = nextBranch;
    this._persist();
  }

  /**
   * Reverts a PR this session merged: opens GitHub's revert PR, merges it
   * and deletes its branch. If the session has no uncommitted work, its
   * checkout is then moved onto the updated default branch so Claude sees
   * the reverted code; otherwise it's left alone (returned as
   * `synced: false`) so nothing is lost.
   */
  async revertMergedPullRequest(session, pullNumber) {
    const revertPr = await openRevertPullRequest({ owner: session.owner, repo: session.repo, pullNumber });
    const merged = await mergePullRequest({ owner: session.owner, repo: session.repo, pullNumber: revertPr.number });
    await deleteBranch({ owner: session.owner, repo: session.repo, branch: revertPr.headRefName });

    let synced = false;
    if (await isWorkingTreeClean(session.git)) {
      session.undoSnapshot = null;
      await this._rebranch(session);
      synced = true;
    }
    return { revertPr, merged, synced };
  }

  /**
   * Ends a session and removes its working directory. Does NOT commit —
   * call commitAndMerge first if you want pending changes saved; anything
   * still uncommitted at this point is discarded along with the directory.
   * `reason` is just for the log line — 'exit', 'push', or 'idle'.
   */
  async close(session, reason = 'exit') {
    session.teardown();
    this.sessionsByChannel.delete(session.channelId);
    this._persist();
    await cleanupRepoDir(session.dir);
    await cleanupUploadsDir(session.dir);
    await fs.promises.rm(`${session.dir}-refs`, { recursive: true, force: true }); // see session.js referenceReposPrompt

    const labels = {
      exit: '🔴 Session closed (exit)',
      push: '🔴 Session closed (pushed first)',
      idle: '⏱️ Session auto-closed (4h idle timeout)',
    };
    logEvent(
      session.guildId,
      `${labels[reason] ?? labels.exit} on **${session.owner}/${session.repo}** — total cost ~$${session.totalCostUsd.toFixed(2)}`,
    );
  }

  async _handleIdleExpire(session) {
    // Idle timeout: discard anything not already committed+merged (Commit
    // merges immediately now, so there's never a dangling PR to open here),
    // then close as normal.
    await discardPendingChanges(session.git).catch((err) => {
      console.error(`[session ${session.id}] failed to discard pending changes on idle expiry:`, err);
    });
    await this.close(session, 'idle');
    this.onIdleExpire?.(session);
  }
}
