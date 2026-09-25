import { spawn } from 'node:child_process';
import { config } from '../config.js';

const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

// Instructs Claude to offer clickable Discord buttons for genuine
// multiple-choice decisions, instead of just asking in prose. The bot
// parses this fenced block back out of the reply (see reply.js
// parseOptionsBlock) and renders real buttons from it.
const OPTIONS_SYSTEM_PROMPT = `You are chatting with a user through a Discord bot that can render clickable buttons for multiple-choice questions.
When you need the user to pick between a small number of concrete options (not open-ended questions), end your reply with a fenced block like this, on its own lines:
\`\`\`options
A) First option
B) Second option
C) Third option
\`\`\`
Use at most 5 options (A-E), keep each option label short (under 60 characters — it becomes a button label), and only use this for real decisions, not for open-ended or yes/no questions where normal text is clearer.

If you have more than one distinct question or decision to put to the user, ask only ONE per reply and stop there — do not list several questions in the same message. Ask the single most important/blocking one first (using an options block if it's a real multiple-choice decision, or plain text if it's open-ended), end your turn, and wait for their answer before asking the next one. The user's Discord client shows one question at a time; asking several at once means only the first gets a clear answer.

You have the Bash tool available and enabled — use it freely for shell commands (npm/build tools, running tests, git, checking a command's output, etc.).`;

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
    guildId,
    ownerId,
    owner,
    repo,
    dir,
    git,
    branchName,
    defaultBranch,
    claudeSessionId = null,
    hasPushedAnything = false,
    commitCount = 0,
  }) {
    this.id = id;
    this.channelId = channelId;
    this.guildId = guildId;
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
    // Incremented each time a Commit merges and the session re-branches off
    // the default branch, so each new branch/PR gets a unique name.
    this.commitCount = commitCount;
    this.busy = false; // true while a turn is in flight
    this.closed = false;
    this.pendingOptions = null; // option labels from the most recent ```options block, for button clicks

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
      guildId: this.guildId,
      ownerId: this.ownerId,
      owner: this.owner,
      repo: this.repo,
      dir: this.dir,
      branchName: this.branchName,
      defaultBranch: this.defaultBranch,
      claudeSessionId: this.claudeSessionId,
      hasPushedAnything: this.hasPushedAnything,
      commitCount: this.commitCount,
    };
  }

  /**
   * Sends one user turn to Claude Code and resolves with `{ result }` —
   * the final `result` event. `onEvent` is called for every streamed
   * event (assistant tool-use, etc.) so the caller can show progress.
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
      '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash',
      '--append-system-prompt', OPTIONS_SYSTEM_PROMPT,
    ];
    // Agent (and its older name, Task) is blocked so each Discord chat stays
    // a single Claude Code conversation — subagents start with a fresh
    // context and re-read files, which multiplies token usage.
    // --disallowedTools is the actual enforcement mechanism; --allowedTools
    // alone does NOT reliably block a tool it omits (verified against the CLI).
    args.push('--disallowedTools', 'Agent,Task');
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
        resolve({ result: lastResult });
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
