# AiWorkFlo Render deployment

## Status and prerequisites

See [BUILD_ROADMAP.md](../BUILD_ROADMAP.md) for observed progress and blockers. This is a fresh deployment overlay, not the unavailable package from the earlier handoff. The server is an OAuth resource server, not a login provider.

The target is Render workspace `tea-d9vd713l550s738b1at0`, free plan, Singapore, automatic deployments off. Keep both old joshzyl repositories untouched. A Blueprint does not establish that a deployment exists or that its checks passed.

## Review and deploy

1. Review the AiWorkFlo PR and its actual successful checks. Require one approving review and the `build-and-test` status check on main, with stale approvals dismissed and force pushes disabled. Read the protection settings back; workflow presence alone is not enforcement.
2. After approval, merge without rewriting upstream history. Re-run CI on the merge commit. Record its full SHA before creating the Render service. Use this fork only; never link Render to upstream main. Do not merge or deploy an unreviewed PR simply to make a service available.
3. In the AiWorkFlo Render workspace, create a Blueprint from the fork's reviewed main branch and `render.yaml`. Confirm the displayed repository, branch, free plan, Singapore region, and auto-deploy setting. Initial creation deploys the current branch tip, so ensure that tip is the recorded approved SHA. Subsequent deployments must use **Deploy a specific commit** with a reviewed SHA and verify the deployed SHA afterward.
4. Enter secrets only in Render's secure environment interface. The launcher will refuse to start until the required environment is complete. Do not use placeholder credentials to claim readiness. Render supplies `PORT` and `RENDER_EXTERNAL_URL`; the launcher derives the canonical resource as `RENDER_EXTERNAL_URL` plus `/mcp`. An explicit `MCP_PUBLIC_URL` must be HTTPS and end in `/mcp`.

| Setting | Value |
| --- | --- |
| `CLICKUP_API_TOKEN` | Joshua's personal token, entered privately in Render |
| `CLICKUP_WORKSPACE_ID` | Explicit intended workspace ID; not a security boundary for arbitrary object IDs |
| `MCP_OAUTH_ISSUER` | Exact discovery issuer, preserving any trailing slash |
| `MCP_OAUTH_ALLOWED_SUBJECT` | Joshua's immutable provider user ID (`sub`), not an email address |
| `MCP_PROFILE` | `read` |

The launcher disables dotenv and URL tokens, refuses static bearer/Cloudflare alternative credentials, rejects ClickUp API and JWKS overrides, and confines file attachments to `/tmp/aiworkflo-clickup-attachments`. This is ephemeral storage; never put credentials there. No client secrets belong on this resource server.

## Managed authentication

Use Auth0 Auth for MCP unless an existing compatible managed provider is available. Tenant creation and account login require the owner. This repository does not provision a tenant or store provider credentials.

- Create an RS256 API whose identifier is exactly the service's canonical HTTPS `/mcp` URL. Use the same URL as the OAuth resource/audience.
- Configure authorization code with PKCE S256 and a compatible ChatGPT client registration path. Prefer CIMD when supported; verify advertised metadata and exact callbacks against current ChatGPT documentation. Do not invent callback URLs or assume all OIDC providers support MCP registration.
- Enable offline access and refresh-token grant/rotation; test refresh with the real ChatGPT connection. A successful initial login is insufficient.
- Restrict application access to Joshua using provider access policy and disable open signup for this deployment. Also set `MCP_OAUTH_ALLOWED_SUBJECT`: the resource server verifies the signed `sub`, rejecting every other user even if the provider issues a valid token.
- Check issuer metadata, HTTPS JWKS, exact issuer, audience, signature and expiry. The server currently accepts RS256 only and has upstream's 60-second clock-skew allowance. OAuth scope metadata is informational; the deployment's capability profile and exact subject restriction enforce access.
- All accepted calls still use one ClickUp personal token. The workspace setting selects a default; it does not reduce that token's permissions. Never share this app across the organization without explicit review.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Auth0 Auth for MCP](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/), [Auth0 third-party security controls](https://auth0.com/docs/get-started/applications/third-party-applications/security-controls), [Render Blueprint reference](https://render.com/docs/blueprint-spec), [Render deployment controls](https://render.com/docs/deploys).

## Acceptance evidence

Record timestamp, tested commit, service URL, profile and result for each check. Do not publish credentials, JWTs, personal user details or ClickUp content in this public repository.

1. `/health` returns expected version/profile. Both protected-resource metadata paths (root and `/mcp` suffix) match issuer and resource. Health is only a process check.
2. Missing credentials and malformed, expired (outside the skew window), wrong issuer/audience/signature, disallowed subject and token-in-URL requests are rejected. Verify missing `sub` cannot bypass subject restriction. Use controlled fixtures for destructive/invalid-token cases; do not edit real JWT payloads and claim an audience test independent of signature verification.
3. Real OAuth login, authenticated MCP `initialize`, `tools/list`, `whoami`, `tree`, and representative `find`, `task`, `comment`, `checklist` and `docs` reads succeed. Record workspace selection privately. Confirm read-only tools and rejected writes. Test token refresh and reconnect, including Render cold start.
4. Only after read acceptance and approval of explicit disposable sandbox IDs, set `MCP_PROFILE=core` and `MCP_SANDBOX_WRITE_APPROVED=1`. The flag acknowledges approval; it does **not** enforce a sandbox boundary. Use a token/account limited to disposable content for this test. Refresh/recreate the private ChatGPT app so its tool definitions match.
5. Do not run upstream `npm run smoke` unchanged. It uses legacy clients, chooses the first workspace/space, retries creates, and has incomplete cleanup/read-back guarantees. Before any live writes, implement and inspect a narrow MCP harness requiring explicit sandbox workspace/space/list IDs, recording every created ID before the next operation, asserting ownership before cleanup, never blindly retrying creates, and reading back task/comment/checklist changes. Report orphaned resources after partial failures; never clean up by broad name matching.
6. v4 `docs` only searches and reads. It exposes no creation/editing; mark those checks unsupported. v3 legacy client Docs writes and ClickUp's v3 REST API are separate from the v4 MCP tool surface. Do not add Docs writes as an incidental deployment change.
7. Restore `read`, remove the sandbox-write approval flag, refresh the app, and verify real ChatGPT login and tool call. Leave the app private. Stop or suspend the service on authentication failure; never fall back to no-auth or URL tokens.

## Local validation

Use Node 24.19.0 and the committed lockfile:

```sh
npm ci --include=dev
npm test
npm audit --omit=dev --audit-level=high
```

`npm test` builds both upstream implementations and runs all `test/*.test.mjs`, including deployment regressions. Offline fixtures are not live ClickUp, Auth0, Render or ChatGPT acceptance. Consult the roadmap for actual test counts, remaining dependency findings and external checks.
