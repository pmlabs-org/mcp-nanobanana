# Pathfinder fork orientation — Nano Banana MCP

> **Where this fork came from:** https://github.com/zhongweili/nanobanana-mcp-server (forked 2026-04-20 into `PM-Labs/mcp-nanobanana`). The upstream `CLAUDE.md` in this repo is the original project overview — keep it untouched to minimise fork-sync conflicts. **This** file captures Pathfinder-specific additions and operational rules.

## What Pathfinder added on top of upstream

1. **Node OAuth sidecar** (`oauth-server.js`, `Dockerfile`) — spawns the Python FastMCP server on `127.0.0.1:8081` and exposes port 8080 with OAuth 2.0 PKCE + Bearer gating. Adapted from `PM-Labs/mcp-playwright@1d75780` (clean transparent byte-pipe, **no** session resurrection). Token TTL is `2592000` (30 days) — Anthropic's MCP proxy caches tokens; shorter TTLs surface as "disconnected" integrations until re-auth.
2. **Path-security clamp** (`utils/validation_utils.py` `ensure_inside_image_root` + `validate_output_path`; enforced in `tools/generate_image.py`) — when `IMAGE_OUTPUT_DIR` is set (always, in our Docker deploy), every caller-supplied path must resolve inside that root. Closes the two file-system overreach findings from the deploy-time security review. Covered by `tests/test_path_security.py`.
3. **Session-persistence regression harness** (`scripts/test-session-persistence.js`) — generic Pathfinder MCP harness; auto-detects stateful vs stateless. This MCP runs **stateful** (FastMCP default).
4. **`.fork-sync-ignore`** — documents the conflict-resolution intent so weekly cherry-pick syncs don't clobber the patches above.

## Hard rules — do not break

- **Sessions return 404 for unknown `Mcp-Session-Id`.** Never silently remap a stale id to a new child session — it triggers reinitialize storms and corrupts client state. See `feedback_mcp_no_session_resurrection` in `pmtools/CLAUDE.md`.
- **The OAuth proxy must be a transparent byte-pipe.** No `sessionMap`, no body buffering to retry on 404, no setting `Mcp-Session-Id` on responses the proxy originated. If `oauth-server.js` ever grows session state, revert to the last good version.
- **Local edits here do not ship until they reach the droplet.** Push to `origin master`, then `ssh mcp-server "cd /opt/pmin-mcpinfrastructure/repos/mcp-nanobanana && git pull --ff-only && cd /opt/pmin-mcpinfrastructure && bash scripts/check-repos-sync.sh nanobanana && docker compose build nanobanana && docker compose up -d nanobanana"`. The on-droplet sync check blocks rebuild if the clone is dirty or diverged.
- **1Password item names use dash, never pipe.** Credentials are under `Claude_Remote_MCP - Gemini (Nano Banana)` in the `Claude Code` vault. `op://` references don't support pipes.

## Stateful or stateless?

**Stateful** — FastMCP defaults. `initialize` returns a `Mcp-Session-Id` header; every subsequent tool call must echo it. The `scripts/test-session-persistence.js` harness MUST pass on every deploy (stateful assertion set: persistence, no rewrite, 404 on unknown id).

## Credentials (vault: `Claude Code`)

| 1P item | Field | Used by |
|---|---|---|
| `Claude_Remote_MCP - Gemini (Nano Banana)` | `API Key` | `GEMINI_API_KEY` — Python MCP calls `google-genai` SDK |
| `Claude_Remote_MCP - Gemini (Nano Banana)` | `MCP Auth Token` | Bearer token checked by `oauth-server.js` |
| `Claude_Remote_MCP - Gemini (Nano Banana)` | `OAuth Client Secret` | PKCE client_credentials + authorization_code grants |

Real values live in `/opt/pmin-mcpinfrastructure/env/nanobanana.env` on the droplet.

## Deploy

Edit here → push origin → on droplet:
```bash
ssh mcp-server "cd /opt/pmin-mcpinfrastructure/repos/mcp-nanobanana && git pull --ff-only && cd /opt/pmin-mcpinfrastructure && bash scripts/check-repos-sync.sh nanobanana && docker compose build nanobanana && docker compose up -d nanobanana"
```

## Upstream & fork-sync

Weekly cherry-pick auto-sync via `/opt/pmin-mcpinfrastructure/scripts/sync.sh` (Sunday 17:00 UTC). Rejected upstream SHAs go in `.fork-sync-ignore` at this repo's root. If upstream modifies a file we've patched (e.g. `tools/generate_image.py` or `utils/validation_utils.py`), resolve the cherry-pick conflict by **keeping our clamp behavior** — do not revert to upstream's coarse blocklist or re-enable `readOnlyHint: True`.

## Environment variables

| Var | Value | Why |
|---|---|---|
| `FASTMCP_TRANSPORT` | `http` (set by oauth-server.js) | FastMCP bound to 127.0.0.1:8081 |
| `FASTMCP_HOST` | `127.0.0.1` | Internal loopback — no external exposure |
| `FASTMCP_PORT` | `8081` | Matches the oauth-server.js `INTERNAL_PORT` constant |
| `FASTMCP_MASK_ERRORS` | `true` (droplet) | Hides Python tracebacks from remote clients |
| `IMAGE_OUTPUT_DIR` | `/data/images` (Docker volume) | The clamp's allowlist root. Must match the bind mount. |
| `GEMINI_API_KEY` | (from 1P) | Required. API key for google-genai SDK. |
| `GEMINI_BASE_URL` | **unset** | If set, SDK calls go to that URL with the API key attached — misconfiguration silently exfiltrates. Keep unset. |
| `MCP_AUTH_TOKEN` | (from 1P) | Bearer token claude.ai sends |
| `OAUTH_CLIENT_ID` | `claude-pathfinder` | Shared across all Pathfinder MCPs |
| `OAUTH_CLIENT_SECRET` | (from 1P) | Shared with claude.ai Integrations config |

## Related

- **Infrastructure:** `PM-Labs/pmin-mcpinfrastructure` (droplet, Caddy, healthcheck, runbooks)
- **Runbook:** `/opt/pmin-mcpinfrastructure/docs/runbooks/nanobanana.md`
- **Plugin Cloud Connectors entry:** `pmtools/CLAUDE.md` in `PM-Labs/pmin-claude`
- **Relevant memories:** `feedback_mcp_no_session_resurrection`, `feedback_droplet_mcp_repo_sync`, `feedback_op_pipe_char_in_item_names`, `feedback_fork_sync_ignore`
