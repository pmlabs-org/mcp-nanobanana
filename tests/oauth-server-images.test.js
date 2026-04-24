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

const server = require('../oauth-server.js');

test('module exports requestHandler for unit testing', () => {
  assert.equal(typeof server.requestHandler, 'function');
});
