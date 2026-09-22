# AiWorkFlo ClickUp MCP build roadmap

Updated: 2026-09-22. This file records observed progress, not intended results.

## Target and boundaries

Deploy the v4 server to the AiWorkFlo Render workspace `tea-d9vd713l550s738b1at0`, on a free Singapore instance, with automatic deployments disabled. Start read-only and OAuth-protected. Keep the ChatGPT app private. All callers share one ClickUp personal token; OAuth does not give callers separate ClickUp identities or permissions. Do not modify the old joshzyl ClickUp repositories.

## Completed

- Verified GitHub identity `joshzyl` and active AiWorkFlo admin membership.
- Listed AiWorkFlo repositories before creation; the requested fork did not exist.
- Created https://github.com/AiWorkFlo/clickup-mcp-server as a real GitHub fork of `benthesoundguy/clickup-mcp-server`.
- Cloned full history into this checkout. Fork main matches pinned upstream `78ae9837b85b1b6ae92c05e482306aab87acd790` (package 4.3.1).
- Created `deploy/aiworkflo-render` from that commit. No reset or force push.
- Read upstream README, architecture notes, startup/auth code and live smoke script. No AGENTS.md or CLAUDE.md found in the pinned tree.
- Original deployment overlay was not available. The user agreed to a fresh setup; previous launcher-test claims are not reused.

## Implementation and validation completed

- Added Render Blueprint and a fail-closed v4 launcher: OAuth only, required exact subject, read default, explicit core approval flag, strict environment, sandboxed attachments and Render port binding.
- Fixed exact OAuth issuer handling (including trailing slash) and required a matching discovery issuer. Added an optional signed-subject restriction, required by the Render launcher.
- Added 10 regression tests and SHA-pinned CI actions. All upstream test files remain enabled.
- `npm ci` completed with Node 24.19.0 after redirecting npm's cache to writable `/tmp/aiworkflo-npm-cache`. The first install attempt failed because the default cache was read-only; an early test attempt before installation completed failed with `tsc: not found`. These environment failures were resolved, not hidden.
- `npm test` passed after targeted dependency updates: **372 tests, 56 suites, 372 passed, 0 failed/cancelled/skipped/todo**. This includes the complete upstream offline suite and 10 new tests. Build succeeded as part of this command. Tests use local ClickUp and signed-token fixtures, not live services.
- Updated compatible locked versions of fast-uri, hono, qs, brace-expansion, js-yaml and diff. Also synchronized stale lockfile package/bin metadata with package.json.
- Runtime audit: **0 vulnerabilities** (`npm audit --omit=dev`). Full audit: **6 high findings** remain in the development-only TypeScript ESLint/minimatch chain. Fix suggestions require a major tooling upgrade; deferred to a separate change to preserve deployment scope. Render prunes dev dependencies after building/testing. Do not describe the whole dependency tree as vulnerability-free.
- `render.yaml` passed JSON Schema validation against https://render.com/schema/render.yaml.json. This is schema validation, not an authenticated Render Blueprint deployment.
- Configured main branch protection through GitHub API: one approving review, dismiss stale reviews, require up-to-date `build-and-test`, enforce for admins, require resolved conversations, disable force pushes and deletions. API read-back is required before final handoff.

## In progress

Open the deployment PR, observe GitHub CI, and record the exact tested SHA and check URLs. No PR approval or deployment has occurred.

## Pending deployment and acceptance

1. Obtain authenticated Render management access. No Render tool, CLI credential variable, or Render plugin was found in this session. Do not claim service creation.
2. Configure an established OAuth provider for Joshua only. No provider tenant or credentials exist in this session. Choose managed Auth0 if no existing compatible provider is supplied, and verify its current ChatGPT compatibility before configuration.
3. Enter the ClickUp token only through Render's secure environment UI; never store it in chat, repository files or a committed .env. Set the exact intended workspace and OAuth issuer/resource there.
4. Review/approve the PR and deploy only its approved, tested AiWorkFlo commit. Record Render service ID, URL, workspace, region, plan and deployed SHA.
5. Verify health, protected-resource metadata, issuer discovery and JWKS; reject missing, malformed, expired, wrong-issuer/audience/signature and unauthorized-user tokens. Verify authenticated MCP initialize/tools/list and representative ClickUp reads.
6. Only after reads and sandbox approval, temporarily enable core and refresh ChatGPT tool definitions. Test only disposable resources with recorded IDs and read-back assertions. Restore read and refresh tools after testing.
7. Observe real ChatGPT OAuth login, refresh and tool call. Keep app private until acceptance.

## Smoke-test restrictions

Do not run upstream `npm run smoke` unchanged: it chooses the first workspace and space, writes workspace-level objects, retries some creates, and tests legacy compiled clients rather than deployed v4 MCP. A safe harness must require explicit sandbox IDs, track created IDs, avoid ambiguous create retries, assert persisted state, and clean up only test-owned resources. v4 `docs` is search/read only; legacy client Docs writes are not evidence of v4 tool support.

## Evidence and next action

Local evidence is recorded above. Next: publish the PR and verify GitHub checks. Live Render, ClickUp and ChatGPT acceptance remain blocked by account access and missing secure configuration. Never put tokens or private ClickUp content in this public fork.
