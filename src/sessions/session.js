import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../config.js';

const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const IDLE_WARNING_BEFORE_MS = 15 * 60 * 1000; // warn 15 minutes before the idle auto-close

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

// Tells Claude where and how to pull in other GitHub repos for reference.
// `gh` authenticates from GITHUB_TOKEN, so this reaches any repo that token
// can read. Refs live outside the session's working directory (a sibling
// `<dir>-refs`, like attachments.js's uploads) so Commit never picks them up.
function referenceReposPrompt(refsDir) {
  return `If the user asks you to look at another GitHub repo for reference (e.g. "look at how we did it in my-other-repo"):
- List the account's repos with \`gh repo list <owner> --limit 200\` if you need to find the right one (owner of the current repo: see \`git remote get-url origin\`).
- For a whole repo, shallow-clone it into the reference folder: \`gh repo clone <owner>/<repo> ${refsDir}/<repo> -- --depth 1\` (skip if it's already there), then read it with your normal tools.
- For just one or two files, \`gh api repos/<owner>/<repo>/contents/<path> -H "Accept: application/vnd.github.raw"\` is quicker.
Reference repos are read-only: never edit, commit or push in ${refsDir} — only copy what's useful into the current repo.`;
}

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
    model = null,
    totalCostUsd = 0,
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
    // Model alias passed to --model (e.g. 'sonnet', 'opus'); null uses
    // config.claude.defaultModel, or the account default if that's unset too.
    this.model = model;
    // Running total of the cost Claude Code reports per turn (total_cost_usd
    // on the result event) — an estimate on subscription logins.
    this.totalCostUsd = totalCostUsd;
    this.busy = false; // true while the `claude` process is running
    // true for the whole of handlers.js runTurn — wider than `busy`: also
    // covers posting the reply and running queued messages afterwards.
    this.turnActive = false;
    this.closed = false;
    this.pendingOptions = null; // option labels from the most recent ```options block, for button clicks
    this.queuedMessages = []; // user messages sent while busy, run together as the next turn

    this._child = null; // the in-flight `claude` process, if any (for stop())
    this._stopRequested = false;
    this._idleTimer = null;
    this._idleWarningTimer = null;
    this._onIdleExpire = null; // set by SessionManager
    this._onIdleWarning = null; // set by SessionManager
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
      model: this.model,
      totalCostUsd: this.totalCostUsd,
    };
  }

  /**
   * Forgets Claude's conversation history so the next message starts a new
   * Claude conversation on the same repo/branch. Files on disk are
   * untouched. Long conversations get more expensive per message (the whole
   * history is resent each turn), so this is the cheap way to reset.
   */
  resetConversation() {
    this.claudeSessionId = null;
    this._onChange?.(this);
  }

  setModel(model) {
    this.model = model;
    this._onChange?.(this);
  }

  /** Kills the in-flight turn, if any. The pending sendMessage resolves with `{ result: null, stopped: true }`. */
  stop() {
    if (!this._child) return false;
    this._stopRequested = true;
    this._child.kill('SIGTERM');
    return true;
  }

  /** Resets the idle auto-close countdown (used by the idle warning's Keep alive button). */
  keepAlive() {
    this._touchIdleTimer();
  }

  /**
   * Sends one user turn to Claude Code and resolves with `{ result, stopped }`
   * — `result` is the final `result` event (null if the turn was stopped via
   * stop()). `onEvent` is called for every streamed event (assistant
   * tool-use, etc.) so the caller can show progress.
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

    const refsDir = `${this.dir}-refs`;
    fs.mkdirSync(refsDir, { recursive: true });

    const args = [
      '-p', text,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash,WebSearch,WebFetch,TodoWrite',
      '--append-system-prompt', `${OPTIONS_SYSTEM_PROMPT}\n\n${referenceReposPrompt(refsDir)}`,
      '--add-dir', refsDir,
    ];
    // Agent (and its older name, Task) is blocked so each Discord chat stays
    // a single Claude Code conversation — subagents start with a fresh
    // context and re-read files, which multiplies token usage.
    // --disallowedTools is the actual enforcement mechanism; --allowedTools
    // alone does NOT reliably block a tool it omits (verified against the CLI).
    args.push('--disallowedTools', 'Agent,Task');
    const model = this.model || config.claude.defaultModel;
    if (model) {
      args.push('--model', model);
    }
    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }

    this._stopRequested = false;
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd: this.dir, env });
      this._child = child;
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
          if (event.type === 'result') {
            lastResult = event;
            if (typeof event.total_cost_usd === 'number') {
              this.totalCostUsd += event.total_cost_usd;
              this._onChange?.(this);
            }
          }
          onEvent?.(event);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        this.busy = false;
        this._child = null;
        reject(err);
      });

      child.on('close', (code) => {
        this.busy = false;
        this._child = null;
        if (this._stopRequested) {
          resolve({ result: null, stopped: true });
          return;
        }
        if (code !== 0 && !lastResult) {
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(-2000)}`));
          return;
        }
        resolve({ result: lastResult, stopped: false });
      });
    });
  }

  _touchIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._idleWarningTimer) clearTimeout(this._idleWarningTimer);
    this._idleWarningTimer = setTimeout(() => {
      this._onIdleWarning?.(this);
    }, IDLE_TIMEOUT_MS - IDLE_WARNING_BEFORE_MS);
    this._idleTimer = setTimeout(() => {
      this._onIdleExpire?.(this);
    }, IDLE_TIMEOUT_MS);
  }

  /** Clears timers and kills any in-flight turn. */
  teardown() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._idleWarningTimer) clearTimeout(this._idleWarningTimer);
    this._child?.kill('SIGTERM');
    this.closed = true;
  }
}
