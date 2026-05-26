#!/usr/bin/env node
/**
 * OAuth 2.0 PKCE proxy for nanobanana-mcp.
 *
 * Spawns the Python FastMCP server on an internal port (FASTMCP_PORT=8081),
 * then exposes:
 *   - OAuth discovery + PKCE auth endpoints on the public PORT (default 8080)
 *   - Bearer token gating on all other paths
 *   - Transparent proxy (including SSE streaming) to the internal MCP server
 *
 * Required env vars:
 *   MCP_AUTH_TOKEN      — shared secret issued as Bearer token after OAuth
 *   OAUTH_CLIENT_ID     — OAuth client ID (use "claude-pathfinder")
 *   OAUTH_CLIENT_SECRET — OAuth client secret
 *
 * Optional env vars:
 *   PORT                — public port (default: 8080)
 *
 * Pathfinder fork notes:
 *   - Adapted from PM-Labs/mcp-playwright@1d75780 (clean byte-pipe, no session
 *     resurrection). Do NOT reintroduce the sessionMap / session-resurrection
 *     pattern — see feedback_mcp_no_session_resurrection in the main CLAUDE.md.
 *   - expires_in is 7776000 (90 days), not 86400 (24h). Anthropic's MCP proxy
 *     caches tokens and the integration shows "disconnected" after expiry.
 */
'use strict';

const http = require('http');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { URLSearchParams } = require('url');
const fs = require('node:fs');
const fsPath = require('node:path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const INTERNAL_PORT = 8081;
const AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || '').trim();
const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID || 'claude-pathfinder').trim();
const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET || '').trim();
const TOKEN_TTL_SECONDS = 7776000;
const IMAGE_OUTPUT_DIR = (process.env.IMAGE_OUTPUT_DIR || '/data/images').trim();
const UUID_V4_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Record<string, {codeChallenge:string, codeChallengeMethod:string, redirectUri:string, expiresAt:number}>} */
const authCodes = {};

// Token issuance tracking — persisted so the expiry-warning cron can read it.
const TOKEN_META_PATH = '/tmp/mcp-token-meta.json';
let tokenIssuedAt = null;
try {
  const meta = JSON.parse(fs.readFileSync(TOKEN_META_PATH, 'utf8'));
  if (meta.issued_at) tokenIssuedAt = meta.issued_at;
} catch { /* no prior issuance on record */ }

function recordTokenIssuance() {
  tokenIssuedAt = Math.floor(Date.now() / 1000);
  try {
    fs.writeFileSync(TOKEN_META_PATH, JSON.stringify({ issued_at: tokenIssuedAt, expires_in: TOKEN_TTL_SECONDS }));
  } catch (err) {
    console.error('Failed to write token meta:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseFormBody(body) {
  const result = {};
  for (const [k, v] of new URLSearchParams(body)) result[k] = v;
  return result;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Retry until the Python FastMCP HTTP port accepts connections. */
function waitForMcp() {
  return new Promise((resolve) => {
    const check = () => {
      const req = http.request({ hostname: '127.0.0.1', port: INTERNAL_PORT, path: '/' }, () => resolve());
      req.on('error', () => setTimeout(check, 500));
      req.end();
    };
    setTimeout(check, 1000);
  });
}

/** Transparent proxy: req → internal nanobanana-mcp, pipe response back (handles SSE). */
function proxyRequest(req, res) {
  if (req.url === '/mcp') {
    console.log('[PROXY]', req.method, req.url,
      'session=' + (req.headers['mcp-session-id'] || 'NONE'),
      'accept=' + (req.headers['accept'] || 'NONE'));
  }

  const headers = { ...req.headers, host: `localhost:${INTERNAL_PORT}` };
  // Strip headers that cause the internal server to reject proxied requests:
  // - authorization: the Bearer token is consumed by this proxy, not the MCP server
  // - origin: prevents CORS rejection when request originates from claude.ai
  delete headers['authorization'];
  delete headers['origin'];

  const opts = {
    hostname: '127.0.0.1',
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers,
  };
  const proxy = http.request(opts, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      let body = '';
      proxyRes.on('data', (chunk) => { body += chunk; });
      proxyRes.on('end', () => {
        console.error(`Upstream ${proxyRes.statusCode} for ${req.method} ${req.url}: ${body.slice(0, 500)}`);
      });
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) json(res, 502, { error: 'bad_gateway' });
    else res.destroy();
  });
  req.pipe(proxy, { end: true });
}

function serveImage(req, res, pathname) {
  // Expected shape: /images/<uuid>.png
  const match = pathname.match(/^\/images\/([^/]+)\.png$/);
  if (!match) { json(res, 400, { error: 'bad_request' }); return; }
  const id = match[1];
  if (!UUID_V4_RX.test(id)) { json(res, 400, { error: 'invalid_id' }); return; }

  const root = fsPath.resolve(IMAGE_OUTPUT_DIR);
  const filePath = fsPath.resolve(root, 'temp_images', `${id}.png`);
  if (filePath !== fsPath.join(root, 'temp_images', `${id}.png`)) {
    // Defensive belt-and-braces clamp. resolve() should never produce a path
    // outside root for a regex-validated id, but keep the explicit check.
    json(res, 403, { error: 'forbidden' });
    return;
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') { json(res, 404, { error: 'not_found' }); return; }
    console.error('image stat error:', err.message);
    json(res, 500, { error: 'internal_error' });
    return;
  }
  if (!stats.isFile()) { json(res, 404, { error: 'not_found' }); return; }

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': stats.size,
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('image stream error:', err.message);
    res.destroy();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Image upload route
// ---------------------------------------------------------------------------

const UPLOAD_MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

async function handleUpload(req, res) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_MIME_TO_EXT[contentType];
  if (!ext) {
    json(res, 415, { error: 'unsupported_media_type', message: 'Content-Type must be image/jpeg, image/png, image/webp, or image/gif' });
    return;
  }

  const chunks = [];
  let received = 0;
  let tooLarge = false;

  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > UPLOAD_MAX_BYTES) {
        tooLarge = true;
        // Don't push any more chunks but keep draining so the response can be sent cleanly
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  if (tooLarge) {
    if (!res.headersSent) json(res, 413, { error: 'payload_too_large', message: 'Maximum upload size is 20MB' });
    return;
  }

  const imageBytes = Buffer.concat(chunks);
  const uuid = randomUUID();
  const uploadsDir = fsPath.join(fsPath.resolve(IMAGE_OUTPUT_DIR), 'uploads');
  let filePath;
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    filePath = fsPath.join(uploadsDir, `${uuid}${ext}`);
    fs.writeFileSync(filePath, imageBytes);
  } catch (err) {
    console.error('[UPLOAD] write error:', err.message);
    if (!res.headersSent) json(res, 500, { error: 'internal_error', message: 'Failed to save uploaded file' });
    return;
  }

  console.log(`[UPLOAD] ${imageBytes.length} bytes → ${filePath}`);
  json(res, 200, { server_path: filePath, uuid });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Health check (no auth required) — Docker healthcheck hits this
    if (path === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' });
      return;
    }

    // OAuth Protected Resource Metadata
    if (path === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
      const base = `https://${req.headers.host}`;
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }

    // OAuth Authorization Server Metadata
    if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      const base = `https://${req.headers.host}`;
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/oauth/token`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
      });
      return;
    }

    // Authorization endpoint
    if (path === '/authorize' && req.method === 'GET') {
      const response_type = url.searchParams.get('response_type');
      const client_id = url.searchParams.get('client_id');
      const redirect_uri = url.searchParams.get('redirect_uri');
      const code_challenge = url.searchParams.get('code_challenge');
      const code_challenge_method = url.searchParams.get('code_challenge_method') || 'S256';
      const state = url.searchParams.get('state');

      if (client_id !== OAUTH_CLIENT_ID) { json(res, 401, { error: 'invalid_client' }); return; }
      if (response_type !== 'code') { json(res, 400, { error: 'unsupported_response_type' }); return; }
      if (!code_challenge) { json(res, 400, { error: 'code_challenge_required' }); return; }

      const code = randomUUID();
      authCodes[code] = {
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        redirectUri: redirect_uri,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return;
    }

    // Token endpoint
    if (path === '/oauth/token' && req.method === 'POST') {
      if (!OAUTH_CLIENT_ID || !AUTH_TOKEN) { json(res, 500, { error: 'server_misconfigured' }); return; }

      const bodyRaw = await readBody(req);
      const contentType = req.headers['content-type'] || '';
      const body = contentType.includes('application/json') ? JSON.parse(bodyRaw) : parseFormBody(bodyRaw);
      const grant_type = body.grant_type;

      if (grant_type === 'authorization_code') {
        const { code, code_verifier, redirect_uri } = body;
        const stored = authCodes[code];
        if (!stored || stored.expiresAt < Date.now()) { json(res, 400, { error: 'invalid_grant' }); return; }
        const expected = createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== stored.codeChallenge) { json(res, 400, { error: 'invalid_grant' }); return; }
        if (redirect_uri && redirect_uri !== stored.redirectUri) { json(res, 400, { error: 'invalid_grant' }); return; }
        delete authCodes[code];
        recordTokenIssuance();
        json(res, 200, { access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS });
        return;
      }

      // client_credentials grant
      if (!OAUTH_CLIENT_SECRET) { json(res, 500, { error: 'server_misconfigured' }); return; }
      let client_id;
      let client_secret;
      const basicAuth = req.headers['authorization'];
      if (basicAuth && basicAuth.startsWith('Basic ')) {
        const decoded = Buffer.from(basicAuth.slice(6), 'base64').toString();
        const colon = decoded.indexOf(':');
        client_id = decoded.slice(0, colon);
        client_secret = decoded.slice(colon + 1);
      } else {
        client_id = body.client_id;
        client_secret = body.client_secret;
      }
      if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
        json(res, 401, { error: 'invalid_client' });
        return;
      }
      recordTokenIssuance();
      json(res, 200, { access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS });
      return;
    }

    // Token expiry metadata (unauthenticated — reveals only a timestamp)
    if (path === '/.well-known/token-expiry' && req.method === 'GET') {
      if (tokenIssuedAt === null) { json(res, 404, { error: 'no_token_issued' }); return; }
      json(res, 200, {
        issued_at: tokenIssuedAt,
        expires_in: TOKEN_TTL_SECONDS,
        expires_at: tokenIssuedAt + TOKEN_TTL_SECONDS,
      });
      return;
    }

    // Bearer token enforcement for all other routes
    if (AUTH_TOKEN) {
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const host = req.headers.host;
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="https://${host}/.well-known/oauth-protected-resource"`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (authHeader.slice(7) !== AUTH_TOKEN) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Image download route (bearer-authed, GET-only)
    if (path.startsWith('/images/')) {
      if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return; }
      serveImage(req, res, path);
      return;
    }

    // Image upload route (bearer-authed, POST-only)
    if (path === '/upload') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
      await handleUpload(req, res);
      return;
    }

    // Transparent proxy (pipes SSE through as-is)
    proxyRequest(req, res);
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal_server_error' });
  }
});

// ---------------------------------------------------------------------------
// Start Python FastMCP on internal port
// ---------------------------------------------------------------------------

function startMcpChild() {
  const mcpProcess = spawn('python', ['-m', 'nanobanana_mcp_server.server'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FASTMCP_TRANSPORT: 'http',
      FASTMCP_HOST: '127.0.0.1',
      FASTMCP_PORT: String(INTERNAL_PORT),
    },
  });

  mcpProcess.on('exit', (code) => {
    console.error(`nanobanana-mcp exited with code ${code}`);
    process.exit(code ?? 1);
  });

  process.on('SIGTERM', () => {
    mcpProcess.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Start proxy after MCP is ready
// ---------------------------------------------------------------------------

if (process.env.NODE_TEST !== '1') {
  startMcpChild();
  waitForMcp().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`OAuth proxy listening on port ${PORT} → nanobanana-mcp on port ${INTERNAL_PORT}`);
    });
  }).catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  requestHandler: server.listeners('request')[0],
};
