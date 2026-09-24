import { spawn } from 'node:child_process';
import { config } from '../config.js';

const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * One active Claude Code chat session, scoped to a repo's checked-out
 * branch directory. There is no single long-lived `claude` process —
 * `claude -p --input-format stream-json` does not behave like a REPL
 * (each stdin write re-initializes rather than continuing the
 * conversation; verified directly against the CLI). Instead, each
 * message spawns a short-lived `claude -p --resume <session-id>` process
 * that reuses Claude's own on-disk conversation history, which gives the
 * same continuous-conversation experience in Discord without keeping a
 * process alive between messages.
 */
export class Session {
  constructor({
    id,
    channelId,
    ownerId,
    owner,
    repo,
    dir,
    git,
    branchName,
    defaultBranch,
    claudeSessionId = null,
    hasPushedAnything = false,
  }) {
    this.id = id;
    this.channelId = channelId;
    this.ownerId = ownerId;
    this.owner = owner;
    this.repo = repo;
    this.dir = dir;
    this.git = git;
    this.branchName = branchName;
    this.defaultBranch = defaultBranch;

    // Set after the first turn (or restored from disk on boot), used for --resume
    this.claudeSessionId = claudeSessionId;
    this.hasPushedAnything = hasPushedAnything;
    this.busy = false; // true while a turn is in flight
    this.closed = false;

    this._idleTimer = null;
    this._onIdleExpire = null; // set by SessionManager
    this._onChange = null; // set by SessionManager; called whenever persisted fields change

    this._touchIdleTimer();
  }

  /** Plain-object snapshot of everything needed to restore this session after a restart. */
  toJSON() {
    return {
      id: this.id,
      channelId: this.channelId,
      ownerId: this.ownerId,
      owner: this.owner,
      repo: this.repo,
      dir: this.dir,
      branchName: this.branchName,
      defaultBranch: this.defaultBranch,
      claudeSessionId: this.claudeSessionId,
      hasPushedAnything: this.hasPushedAnything,
    };
  }

  /**
   * Sends one user turn to Claude Code and resolves with the final
   * `result` event. `onEvent` is called for every streamed event
   * (assistant tool-use, etc.) so the caller can show progress.
   */
  sendMessage(text, { onEvent } = {}) {
    if (this.closed) return Promise.reject(new Error('Session is closed'));
    if (this.busy) return Promise.reject(new Error('Still working on the previous message'));

    this._touchIdleTimer();
    this.busy = true;

    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config.claude.configDir,
    };
    if (config.claude.apiKey) env.ANTHROPIC_API_KEY = config.claude.apiKey;

    const args = [
      '-p', text,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep',
    ];
    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }

    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd: this.dir, env });
      // No stdin is piped in -p mode with a text prompt arg — close it
      // immediately so Claude doesn't spend ~3s waiting to see if stdin
      // data is coming (verified against the CLI: it warns and stalls
      // otherwise).
      child.stdin.end();
      let buffer = '';
      let lastResult = null;
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.session_id && event.session_id !== this.claudeSessionId) {
            this.claudeSessionId = event.session_id;
            this._onChange?.(this);
          }
          if (event.type === 'result') lastResult = event;
          onEvent?.(event);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        this.busy = false;
        reject(err);
      });

      child.on('close', (code) => {
        this.busy = false;
        if (code !== 0 && !lastResult) {
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(-2000)}`));
          return;
        }
        resolve(lastResult);
      });
    });
  }

  _touchIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._onIdleExpire?.(this);
    }, IDLE_TIMEOUT_MS);
  }

  /** Clears timers. No child process to kill between messages by design. */
  teardown() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this.closed = true;
  }
}
