# Client Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /upload` to `oauth-server.js` so Claude can stream local image files to the NanoBanana server and use them as conditioning inputs for `generate_image`.

**Architecture:** Raw-body HTTP upload (no multipart, no npm deps) added to the existing OAuth sidecar. Saved files land inside `IMAGE_OUTPUT_DIR/uploads/` so the path-security clamp in `generate_image` passes automatically. The `pm.des.nano` skill gets a new Step 6.5 that curl-uploads local paths before calling the MCP tool, swapping in the returned server paths.

**Tech Stack:** Node.js stdlib (`http`, `fs`, `path`, `crypto`), Python FastMCP (unchanged), bash + curl in pm.des.nano.

---

### Task 1: Write failing tests for POST /upload

**Files:**
- Modify: `tests/oauth-server-images.test.js`

- [ ] **Step 1: Extend the `invoke` helper to support a request body**

In `tests/oauth-server-images.test.js`, replace the existing `invoke` function (lines 34–54) with this version that accepts an optional `body` buffer:

```javascript
function invoke({ method = 'GET', url, headers = {}, body = null } = {}) {
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
      if (body) req.write(body);
      req.end();
    });
  });
}
```

- [ ] **Step 2: Append upload tests at the end of the test file**

```javascript
// ---------------------------------------------------------------------------
// POST /upload
// ---------------------------------------------------------------------------

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

test('POST /upload — valid bearer + image/png → 200 with server_path inside uploads dir', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer', 'content-type': 'image/png' },
    body: FAKE_PNG,
  });
  assert.equal(r.statusCode, 200);
  const payload = JSON.parse(r.body.toString());
  assert.ok(payload.server_path, 'server_path missing');
  assert.ok(payload.server_path.endsWith('.png'), 'wrong extension');
  assert.ok(payload.server_path.includes('uploads'), 'not in uploads dir');
  assert.ok(payload.server_path.startsWith(tmpRoot), 'outside IMAGE_OUTPUT_DIR');
  assert.ok(fs.existsSync(payload.server_path), 'file not created on disk');
});

test('POST /upload — image/jpeg → 200 with .jpg extension', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer', 'content-type': 'image/jpeg' },
    body: FAKE_JPEG,
  });
  assert.equal(r.statusCode, 200);
  const payload = JSON.parse(r.body.toString());
  assert.ok(payload.server_path.endsWith('.jpg'));
});

test('POST /upload — image/webp → 200 with .webp extension', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer', 'content-type': 'image/webp' },
    body: Buffer.from([0x52, 0x49, 0x46, 0x46]),
  });
  assert.equal(r.statusCode, 200);
  const payload = JSON.parse(r.body.toString());
  assert.ok(payload.server_path.endsWith('.webp'));
});

test('POST /upload — unsupported content-type → 415', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer', 'content-type': 'text/plain' },
    body: Buffer.from('hello'),
  });
  assert.equal(r.statusCode, 415);
});

test('POST /upload — missing authorization → 401', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { 'content-type': 'image/png' },
    body: FAKE_PNG,
  });
  assert.equal(r.statusCode, 401);
});

test('POST /upload — wrong bearer → 401', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer wrong', 'content-type': 'image/png' },
    body: FAKE_PNG,
  });
  assert.equal(r.statusCode, 401);
});

test('POST /upload — payload exceeds 20MB → 413', async () => {
  const bigBody = Buffer.alloc(21 * 1024 * 1024, 0x00);
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer', 'content-type': 'image/png' },
    body: bigBody,
  });
  assert.equal(r.statusCode, 413);
});

test('GET /upload — method not allowed → 405', async () => {
  const r = await invoke({
    method: 'GET',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer' },
  });
  assert.equal(r.statusCode, 405);
});

test('POST /upload — response includes uuid matching server_path filename', async () => {
  const r = await invoke({
    method: 'POST',
    url: '/upload',
    headers: { authorization: 'Bearer test-bearer', 'content-type': 'image/png' },
    body: FAKE_PNG,
  });
  assert.equal(r.statusCode, 200);
  const payload = JSON.parse(r.body.toString());
  assert.ok(UUID_V4_RX.test(payload.uuid), 'uuid not a valid UUID v4');
  assert.ok(payload.server_path.includes(payload.uuid), 'server_path does not contain uuid');
});
```

Note: `UUID_V4_RX` is already defined at the top of the test file as a module-level const — the test can reference it.

- [ ] **Step 3: Run tests to confirm they all fail**

```bash
cd /c/Users/mitch/mcp-nanobanana
node --test tests/oauth-server-images.test.js 2>&1 | tail -30
```

Expected: All new upload tests fail with `TypeError` or similar — `handleUpload` doesn't exist yet.

---

### Task 2: Implement POST /upload in oauth-server.js

**Files:**
- Modify: `oauth-server.js`

- [ ] **Step 1: Add the `handleUpload` function**

In `oauth-server.js`, insert the `handleUpload` function after the closing brace of `serveImage` (after line 181, before the `// HTTP server` comment):

```javascript
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
        req.destroy();
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', (err) => {
      if (tooLarge) resolve(); else reject(err);
    });
  });

  if (tooLarge) {
    if (!res.headersSent) json(res, 413, { error: 'payload_too_large', message: 'Maximum upload size is 20MB' });
    return;
  }

  const imageBytes = Buffer.concat(chunks);
  const uuid = randomUUID();
  const uploadsDir = fsPath.join(fsPath.resolve(IMAGE_OUTPUT_DIR), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filePath = fsPath.join(uploadsDir, `${uuid}${ext}`);
  fs.writeFileSync(filePath, imageBytes);

  console.log(`[UPLOAD] ${imageBytes.length} bytes → ${filePath}`);
  json(res, 200, { server_path: filePath, uuid });
}
```

- [ ] **Step 2: Add the route to the HTTP server request handler**

In `oauth-server.js`, add the `/upload` route check after the `/images/` block (after line 328, before `proxyRequest`):

```javascript
    // Image upload route (bearer-authed, POST-only)
    if (path === '/upload') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }
      await handleUpload(req, res);
      return;
    }
```

---

### Task 3: Verify all tests pass

**Files:** (none changed)

- [ ] **Step 1: Run the full test suite**

```bash
cd /c/Users/mitch/mcp-nanobanana
node --test tests/oauth-server-images.test.js 2>&1
```

Expected output: All tests pass including the 9 new upload tests. No failures. Final line: `# tests N, pass N`.

If any test fails, fix `oauth-server.js` before continuing.

---

### Task 4: Update CLAUDE.pathfinder.md

**Files:**
- Modify: `CLAUDE.pathfinder.md`

- [ ] **Step 1: Add the upload route section**

In `CLAUDE.pathfinder.md`, after the "Local download route" section (after line 79), add:

```markdown
## Client image upload route (Pathfinder fork, 2026-05-26)

`oauth-server.js` exposes `POST /upload` (bearer-authed, POST-only, raw body).
Accepts `image/jpeg`, `image/png`, `image/webp`, `image/gif` up to 20 MB.
Saves to `{IMAGE_OUTPUT_DIR}/uploads/{uuid}{ext}` — inside `IMAGE_OUTPUT_DIR`
so the path-security clamp in `generate_image` (`ensure_inside_image_root`) accepts
the returned path without modification.

Client pattern (Claude):

```bash
source /tmp/pm-op-cache.env
SERVER_PATH=$(curl -fsS -X POST \
  -H "Authorization: Bearer $NANOBANANA_MCP_AUTH_TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@/local/path/to/image.jpg" \
  "https://nanobanana.mcp.pathfindermarketing.com.au/upload" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['server_path'])")
# Then pass $SERVER_PATH as input_image_path_1 to generate_image
```

Uploads are not TTL-tracked — they accumulate in `{IMAGE_OUTPUT_DIR}/uploads/` until
the container is recreated. Low-volume use; clean up manually if disk becomes a concern.
```

---

### Task 5: Commit and push mcp-nanobanana

**Files:** (all changes in this repo)

- [ ] **Step 1: Stage and commit**

```bash
cd /c/Users/mitch/mcp-nanobanana
git add oauth-server.js tests/oauth-server-images.test.js CLAUDE.pathfinder.md docs/superpowers/plans/2026-05-26-client-image-upload.md
git status
```

Confirm only expected files are staged.

```bash
git commit -m "$(cat <<'EOF'
feat: add POST /upload route for client-side image conditioning

Adds a bearer-authed raw-body upload endpoint to oauth-server.js so Claude
can stream local image files to the server and use them as input_image_path_*
values in generate_image calls. Saves to IMAGE_OUTPUT_DIR/uploads/ — inside
the path-security clamp root.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Push to origin master (triggers CI deploy)**

```bash
git push origin master
```

Expected: GitHub Actions builds Docker image, pushes to GHCR, SSHes to droplet, pulls and recreates the container. Check Actions tab on GitHub to confirm green.

- [ ] **Step 3: Verify deployment**

```bash
curl -s https://nanobanana.mcp.pathfindermarketing.com.au/health
```

Expected: `{"status":"ok"}`

Then smoke-test the upload endpoint (requires bearer token from 1P):

```bash
source /tmp/pm-op-cache.env
TOKEN=$(op item get "Claude_Remote_MCP - Gemini (Nano Banana)" --vault "Claude Code" --field "MCP Auth Token" --reveal)
echo "test" | curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @- \
  "https://nanobanana.mcp.pathfindermarketing.com.au/upload"
```

Expected: `{"server_path":"/data/images/uploads/<uuid>.png","uuid":"<uuid>"}` (415 would mean CI hasn't deployed yet; wait 2 min and retry).

---

### Task 6: Update pm.des.nano skill with Step 6.5

**Files:**
- Modify: `pmtools/skills/pm.des.nano/SKILL.md` (in pmin-claude repo, via `pm.sub.ops.upload.skill`)

- [ ] **Step 1: Read current SKILL.md to get exact location of Step 6 and Step 7**

```bash
grep -n "^## Step" ~/.claude/plugins/cache/pathfinder-marketplace/pmtools/*/skills/pm.des.nano/SKILL.md
```

Note the line numbers for Step 6 and Step 7 — the new Step 6.5 is inserted between them.

- [ ] **Step 2: Invoke pm.sub.ops.upload.skill**

Run `/pm.sub.ops.upload.skill` and provide the following new step to insert between Step 6 and Step 7 of `pm.des.nano/SKILL.md`:

````markdown
## Step 6.5 — Upload local conditioning images (if any)

Skip this step if no `input_image_path_*` values are set, or if all set values are already server-side paths (i.e. start with `/data/images/`).

For each local path that needs uploading:

1. Detect MIME type from file extension:
   - `.jpg` / `.jpeg` → `image/jpeg`
   - `.png` → `image/png`
   - `.webp` → `image/webp`
   - `.gif` → `image/gif`
   - Anything else → `image/jpeg` (fallback)

2. Ensure op-cache is fresh, then fetch bearer token:

```bash
CACHE=/tmp/pm-op-cache.env
NOW=$(date +%s)
CACHE_AGE=$((NOW - $(stat -c %Y "$CACHE" 2>/dev/null || echo 0)))
if [ ! -f "$CACHE" ] || [ "$CACHE_AGE" -gt 1500 ]; then
  bash "$CLAUDE_PLUGIN_ROOT/scripts/op-session-init.sh"
fi
source "$CACHE"
NB_TOKEN=$(op item get "Claude_Remote_MCP - Gemini (Nano Banana)" --vault "Claude Code" --field "MCP Auth Token" --reveal)
```

3. Upload each local path and capture the server path:

```bash
SERVER_PATH=$(curl -fsS -X POST \
  -H "Authorization: Bearer $NB_TOKEN" \
  -H "Content-Type: $MIME_TYPE" \
  --data-binary "@$LOCAL_PATH" \
  "https://nanobanana.mcp.pathfindermarketing.com.au/upload" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['server_path'])")
```

4. Replace the local path with `$SERVER_PATH` in `input_image_path_1/2/3` for the Step 7 call.

**Error handling:** If curl returns non-zero (network error, 401, 413, 415), surface the error to the user and stop — do not proceed to generation with a missing conditioning image.
````

- [ ] **Step 3: Confirm the skill upload completes and the plugin updates**

Run `/pm.ops.update --quick` to pull the latest plugin version. Verify the new step appears:

```bash
grep -A 5 "Step 6.5" ~/.claude/plugins/cache/pathfinder-marketplace/pmtools/*/skills/pm.des.nano/SKILL.md
```

Expected: The Step 6.5 heading and content appear in the file.

---

### Task 7: End-to-end test with the original use case

- [ ] **Step 1: Re-run the Sales Illustrated generation with real conditioning images**

In a new Claude Code session, use `/pm.des.nano` with the two original images as conditioning inputs:
- `C:\Users\mitch\Downloads\Grp 2 - Pathfinder Marketing__0026 (2).jpg` (face reference — bald man)
- `C:\Users\mitch\Downloads\images.jpg` (style reference — Phelps SI cover)

Step 6.5 should auto-upload both, then Step 7 calls `generate_image` with the server paths as `input_image_path_1` and `input_image_path_2`.

Expected: Generated image shows a bald/bearded man conditioned on the actual reference face, placed in a Sales Illustrated cover layout.
