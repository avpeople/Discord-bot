import http from 'node:http';
import { Status } from 'discord.js';
import { config } from './config.js';
import { logEvent } from './log-channel.js';

/**
 * A small inbound HTTP server so external services (e.g. the Sports GFX
 * site) can post a studio-monitoring log line into Discord, without the
 * bot needing to share a Docker network with them — publicly reachable,
 * gated by a required `x-api-key` header matching NOTIFY_API_KEY.
 *
 * The server itself always listens on NOTIFY_PORT, because it also serves
 * the container health check (GET /health) that Docker / Coolify poll.
 * The /notify route is only enabled if NOTIFY_API_KEY is set — without it,
 * POST /notify returns 404, so it stays opt-in and inert by default.
 *
 * Contract: GET /health
 *   -> 200 { "status": "ok", ... } while the Discord gateway connection is
 *      ready, 503 { "status": "starting" | "disconnected", ... } otherwise
 *      (before login finishes, or while reconnecting). No auth — it exposes
 *      nothing beyond up/down and uptime.
 *
 * Contract: POST /notify
 *   headers: x-api-key: <NOTIFY_API_KEY>
 *   body: { "message": "...", "guildId": "...", "kind": "studio" }
 *     - guildId is optional if DISCORD_GUILD_ID is set (defaults to it)
 *     - kind is optional (defaults to "studio" — this endpoint exists for
 *       external studio-monitoring sources, not Claude Code session
 *       events, which log via the in-process logEvent calls instead)
 *   -> 204 on success (or on a silent no-op — see logEvent, which never
 *      throws), 400 on a malformed request, 401 on a missing/wrong key
 */
export function startHttpServer(client) {
  if (!config.notify.apiKey) {
    console.log('NOTIFY_API_KEY not set — inbound /notify endpoint disabled (/health still served).');
  }

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];

    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/health') {
      const ready = client.ws.status === Status.Ready;
      const status = ready ? 'ok' : client.readyAt ? 'disconnected' : 'starting';
      res
        .writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(req.method === 'HEAD' ? undefined : JSON.stringify({ status, uptimeSeconds: Math.round(process.uptime()) }));
      return;
    }

    if (!config.notify.apiKey || req.method !== 'POST' || path !== '/notify') {
      res.writeHead(404).end();
      return;
    }

    if (req.headers['x-api-key'] !== config.notify.apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy(); // guard against an oversized body
    });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const guildId = typeof parsed.guildId === 'string' ? parsed.guildId : config.discord.guildId;
      const kind = typeof parsed.kind === 'string' ? parsed.kind : 'studio';

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'message is required' }));
        return;
      }
      if (!guildId) {
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'guildId is required (or set DISCORD_GUILD_ID on the bot)' }));
        return;
      }

      await logEvent(guildId, message, kind);
      res.writeHead(204).end();
    });
  });

  server.listen(config.notify.port, () => {
    console.log(`HTTP server listening on :${config.notify.port} (/health${config.notify.apiKey ? ', /notify' : ''})`);
  });

  return server;
}
