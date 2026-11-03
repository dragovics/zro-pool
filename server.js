import Fastify from 'fastify';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProxyRoutes } from './lib/proxy.js';
import { stmt, db } from './lib/db.js';
import { pool } from './lib/pool.js';

const PORT = Number(process.env.PORT || 3600);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const app = Fastify({
  logger: { level: LOG_LEVEL },
  trustProxy: process.env.TRUST_PROXY === '1',
  bodyLimit: 64 * 1024 * 1024, // coding agents send big contexts
});

// Buffer pass-through for every content type: /v1/* needs the raw bytes
// (byte-identical forwarding for prefix caching), admin parses JSON itself.
for (const type of ['application/json', 'text/plain', '*']) {
  app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
}

app.get('/healthz', async () => ({ ok: true, uptime: process.uptime() }));

registerAdminRoutes(app);
registerProxyRoutes(app);

// retention: request_log 7 days (every 10 min), sessions idle 24h (hourly)
setInterval(() => {
  try {
    stmt.pruneLogs.run(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } catch { /* best effort */ }
}, 10 * 60 * 1000).unref();

setInterval(() => {
  try {
    pool.pruneSessions();
  } catch { /* best effort */ }
}, 60 * 60 * 1000).unref();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`zro-pool listening on :${PORT} (dashboard: /admin, api: /v1)`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// graceful shutdown (docker stop / systemd restart) — finish in-flight, close db
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    const timeout = setTimeout(() => process.exit(0), 8000).unref();
    try {
      await app.close();
      db.close();
    } catch { /* best effort */ }
    clearTimeout(timeout);
    process.exit(0);
  });
}
