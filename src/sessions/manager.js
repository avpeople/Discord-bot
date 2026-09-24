import crypto from 'node:crypto';
import fs from 'node:fs';
import simpleGit from 'simple-git';
import { prepareRepo, commitAndPush, discardPendingChanges, cleanupRepoDir } from '../repo.js';
import { openPullRequest } from '../github.js';
import { Session } from './session.js';
import { loadSessionsState, saveSessionsState } from './store.js';

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
    session._onChange = () => this._persist();
  }

  _persist() {
    saveSessionsState(Array.from(this.sessionsByChannel.values()).map((s) => s.toJSON()));
  }

  getByChannel(channelId) {
    return this.sessionsByChannel.get(channelId);
  }

  generateSessionId() {
    return crypto.randomUUID().slice(0, 8);
  }

  async createSession({ id: providedId, channelId, ownerId, owner, repo, base }) {
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
   * since the last push. Safe to call repeatedly; no-ops if nothing changed.
   */
  async push(session, message) {
    const commitMessage = message || `Claude Code session ${session.id}`;
    const { pushed } = await commitAndPush(session.git, session.branchName, commitMessage);
    if (pushed && !session.hasPushedAnything) {
      session.hasPushedAnything = true;
      this._persist();
    }
    return pushed;
  }

  /**
   * Ends a session: if there are pushed commits on the branch, opens a PR.
   * Uncommitted working-directory changes are left as-is until
   * cleanupRepoDir removes the whole directory (never silently pushed).
   */
  async close(session) {
    session.teardown();
    this.sessionsByChannel.delete(session.channelId);
    this._persist();

    let pr = null;
    if (session.hasPushedAnything) {
      pr = await openPullRequest({
        owner: session.owner,
        repo: session.repo,
        base: session.defaultBranch,
        head: session.branchName,
        title: `Claude Code session: ${session.repo} (${session.id})`,
        body: `Changes made via an interactive Claude Code Discord session.\n\nBranch: \`${session.branchName}\``,
      });
    }

    await cleanupRepoDir(session.dir);
    return { pr };
  }

  async _handleIdleExpire(session) {
    // Idle timeout: discard anything not already pushed, then close as normal.
    await discardPendingChanges(session.git).catch((err) => {
      console.error(`[session ${session.id}] failed to discard pending changes on idle expiry:`, err);
    });
    const result = await this.close(session);
    this.onIdleExpire?.(session, result);
  }
}
