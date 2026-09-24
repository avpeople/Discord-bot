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

IMPORTANT — Bash tool policy, overrides any other instinct you have about unavailable tools: Bash is currently switched off by a permission setting in this environment, not something that was never built — attempting to call it is exactly what shows the user a real Approve/Deny button in Discord letting them switch it on for you on the spot, for that one attempt. This is a live mechanism the user relies on, and it only works if you actually call the tool rather than reasoning in advance that it won't work.
So: whenever a task would benefit from a shell command (npm/build tools, running tests, git operations beyond what your other tools cover, checking a command's output, anything), call Bash for it FIRST, before writing any explanation — even if it isn't listed among your available tools, or a prior attempt in this same conversation failed. Do not write "Bash isn't available" or "there's no approval-prompt fallback" or similar before trying — that's not something you can know in advance, and saying it without trying is simply incorrect. Only mention Bash being unavailable after an actual attempt in this same turn failed AND the user then declined the resulting approval prompt.`;

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
    this.pendingApprovalText = null; // the user turn text to re-send if a pending Bash denial is approved

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
   * Sends one user turn to Claude Code and resolves with
   * `{ result, permissionDenials }` — `result` is the final `result`
   * event, `permissionDenials` is every denied Bash attempt seen during
   * the turn (usually empty; see handlers.js for how the bot turns a
   * non-empty list into an Approve/Deny prompt). Detected by matching the
   * denied tool_result's error text, not a dedicated system event — see
   * the detection code below for why. `onEvent` is called for every
   * streamed event (assistant tool-use, etc.) so the caller can show
   * progress.
   *
   * `allowBash: true` is used for a one-time re-run after the user
   * approves a Bash request that was previously denied — see the
   * --disallowedTools comment below for why this unlocks Bash entirely
   * for that one spawned process rather than just the specific command
   * that was denied (couldn't be verified cleanly, see git history).
   */
  sendMessage(text, { onEvent, allowBash = false } = {}) {
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
      '--allowedTools', allowBash ? 'Read,Edit,Write,Glob,Grep,Bash' : 'Read,Edit,Write,Glob,Grep',
      '--append-system-prompt', OPTIONS_SYSTEM_PROMPT,
    ];
    // --allowedTools alone does NOT reliably block a tool it omits — verified
    // directly against the CLI: with only --allowedTools set (no
    // --disallowedTools), Claude ran Bash anyway despite it being absent from
    // the allow list. --disallowedTools is the actual enforcement mechanism
    // (confirmed: the first Bash call in a clean test was denied with a real
    // permission_denied event, no workaround). Keep both — --allowedTools
    // documents intent, --disallowedTools is what actually stops it. Note:
    // this was verified on a dev machine whose Claude Code install also
    // exposes a PowerShell tool, which Claude used as a workaround once when
    // explicitly told "use whatever shell tool you have" — the production
    // container (npm-installed CLI on node:20-slim) has no such alternative
    // shell tool, so Bash is the only one to block there, but if this bot is
    // ever run somewhere with another shell-execution tool available, that
    // needs adding here too. Only applied when allowBash is false — an
    // approved re-run needs Bash to actually be usable.
    if (!allowBash) {
      args.push('--disallowedTools', 'Bash');
    }
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
      const permissionDenials = [];

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
          // Verified directly against the real production container (CLI
          // 2.1.197 — a different version/build than a Windows dev machine's
          // native install, which instead emits a `system`/`permission_denied`
          // event that this container never does): a disallowed Bash call
          // comes back as a plain `tool_result` with `is_error: true` and a
          // content string like "Error: No such tool available: Bash. Bash
          // exists but is not enabled in this context." — not a dedicated
          // system event at all. `--disallowedTools Bash` removes Bash from
          // the exposed tool list entirely on this version rather than
          // exposing-but-denying it, so Claude sees it as absent, and this is
          // the only place that shows up.
          if (event.type === 'user' && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (
                block.type === 'tool_result' &&
                block.is_error &&
                typeof block.content === 'string' &&
                /no such tool available: bash/i.test(block.content)
              ) {
                permissionDenials.push({ toolName: 'Bash', message: block.content });
              }
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
        reject(err);
      });

      child.on('close', (code) => {
        this.busy = false;
        if (code !== 0 && !lastResult) {
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(-2000)}`));
          return;
        }
        resolve({ result: lastResult, permissionDenials });
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
