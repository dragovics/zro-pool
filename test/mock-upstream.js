// zro-pool — mock upstream (test/mock-upstream.js)
// Standalone node:http server mimicking the zro /v1 API for e2e tests.
// Behavior is selected by substring of the Bearer key, per SPEC.md section
// "Mock upstream". Node builtins only, ESM, no dependencies.

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 3700);

// Global per-key hit counter for "flaky" keys (hits 1-2 -> 500, 3+ -> 200).
const flakyHits = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const last4 = (key) => key.slice(-4);

function usageForKey(key) {
  const usage = { prompt_tokens: 100, completion_tokens: 20 };
  if (key.includes('warm')) {
    usage.prompt_tokens_details = { cached_tokens: 80 };
  }
  return usage;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

async function handleChat(req, res, raw) {
  const text = raw.toString('utf8').trim();
  if (!text) {
    return sendJson(res, 400, { error: { message: 'empty body' } });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
  }

  const auth = req.headers.authorization || '';
  const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : auth.trim();

  // Error behaviors by key substring (take precedence over success paths).
  if (key.includes('ratelimit')) {
    return sendJson(res, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '1' });
  }
  if (key.includes('unauth')) {
    return sendJson(res, 401, { error: { message: 'invalid api key' } });
  }
  if (key.includes('flaky')) {
    const n = (flakyHits.get(key) || 0) + 1;
    flakyHits.set(key, n);
    if (n <= 2) {
      return sendJson(res, 500, { error: { message: `flaky failure #${n}` } });
    }
  }
  if (key.includes('slow')) {
    await sleep(1200);
  }

  const usage = usageForKey(key);
  const content = `halo dari ${last4(key)}`;

  if (body.stream === true) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // >= 2 delta chunks, then a usage chunk (OpenAI shape), then [DONE].
    for (const piece of ['halo ', 'dari ', last4(key)]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(15);
    }
    res.write(`data: ${JSON.stringify({ usage })}\n\n`);
    await sleep(15);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  return sendJson(res, 200, {
    id: 'chatcmpl-mock',
    choices: [{ message: { role: 'assistant', content } }],
    usage,
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => {});
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    try {
      const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (req.method === 'GET' && pathname === '/v1/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-air' }],
        });
      }
      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        return await handleChat(req, res, raw);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const detail = String((err && err.message) || err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'mock internal error', detail });
      } else {
        res.end();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`mock-upstream listening on ${PORT}`);
});
