const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Ensure test mode: skip listener, skip python spawn.
process.env.NODE_TEST = '1';
process.env.MCP_AUTH_TOKEN = 'test-bearer';
process.env.OAUTH_CLIENT_ID = 'test-client';
process.env.OAUTH_CLIENT_SECRET = 'test-secret';

// Isolate the image root under a temp dir.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-test-'));
fs.mkdirSync(path.join(tmpRoot, 'temp_images'), { recursive: true });
process.env.IMAGE_OUTPUT_DIR = tmpRoot;

// NOTE: env vars above are set at module-init time because oauth-server.js
// reads them at require. Any sibling test file that requires this module
// MUST set the same env vars BEFORE requiring it (require cache is shared).

const { after } = require('node:test');
after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const server = require('../oauth-server.js');
const http = require('node:http');

/**
 * Call the exported handler with a synthetic request.
 * Returns { statusCode, headers, body (Buffer) }.
 */
function invoke({ method = 'GET', url, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(server.requestHandler);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      const req = http.request(
        { host: '127.0.0.1', port, method, path: url, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            s.close();
            resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          });
        },
      );
      req.on('error', (e) => { s.close(); reject(e); });
      req.end();
    });
  });
}

test('module exports requestHandler for unit testing', () => {
  assert.equal(typeof server.requestHandler, 'function');
});

test('GET /images/:id.png — valid bearer + valid UUID + file exists → 200 image/png', async () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad]);
  fs.writeFileSync(path.join(tmpRoot, 'temp_images', `${uuid}.png`), pngBytes);

  const r = await invoke({
    url: `/images/${uuid}.png`,
    headers: { authorization: 'Bearer test-bearer' },
  });

  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.deepEqual(r.body, pngBytes);
});

test('GET /images/:id.png — response includes Content-Length equal to body size', async () => {
  const uuid = '22222222-3333-4444-5555-666666666666';
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
  fs.writeFileSync(path.join(tmpRoot, 'temp_images', `${uuid}.png`), pngBytes);

  const r = await invoke({
    url: `/images/${uuid}.png`,
    headers: { authorization: 'Bearer test-bearer' },
  });

  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-length'], String(pngBytes.length));
  assert.deepEqual(r.body, pngBytes);
});

test('GET /images/:id.png — directory at the expected file path → 404 (not 500)', async () => {
  const uuid = '33333333-4444-5555-6666-777777777777';
  fs.mkdirSync(path.join(tmpRoot, 'temp_images', `${uuid}.png`), { recursive: true });

  const r = await invoke({
    url: `/images/${uuid}.png`,
    headers: { authorization: 'Bearer test-bearer' },
  });

  assert.equal(r.statusCode, 404);
});

test('GET /images/:id.png — missing Authorization header → 401', async () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const r = await invoke({ url: `/images/${uuid}.png` });
  assert.equal(r.statusCode, 401);
});

test('GET /images/:id.png — wrong bearer token → 401', async () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const r = await invoke({
    url: `/images/${uuid}.png`,
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(r.statusCode, 401);
});

test('GET /images/:id.png — malformed UUID → 400', async () => {
  const r = await invoke({
    url: '/images/not-a-uuid.png',
    headers: { authorization: 'Bearer test-bearer' },
  });
  assert.equal(r.statusCode, 400);
});

test('GET /images/:id.png — well-formed UUID but no file → 404', async () => {
  const uuid = 'deadbeef-dead-beef-dead-beefdeadbeef';
  const r = await invoke({
    url: `/images/${uuid}.png`,
    headers: { authorization: 'Bearer test-bearer' },
  });
  assert.equal(r.statusCode, 404);
});

test('GET /images/..%2Fetc%2Fpasswd.png — URL-encoded traversal → 400 (regex rejects)', async () => {
  const r = await invoke({
    url: '/images/..%2Fetc%2Fpasswd.png',
    headers: { authorization: 'Bearer test-bearer' },
  });
  assert.equal(r.statusCode, 400);
});

test('GET /images/some-uuid/extra.png — extra path segments → 400', async () => {
  const r = await invoke({
    url: '/images/11111111-2222-3333-4444-555555555555/extra.png',
    headers: { authorization: 'Bearer test-bearer' },
  });
  assert.equal(r.statusCode, 400);
});

test('POST /images/:id.png — method not allowed (handler refuses non-GET) → 405', async () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const r = await invoke({
    method: 'POST',
    url: `/images/${uuid}.png`,
    headers: { authorization: 'Bearer test-bearer' },
  });
  assert.equal(r.statusCode, 405);
});
