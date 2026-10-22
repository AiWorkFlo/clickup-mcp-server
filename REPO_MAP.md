# Repository map

- `src/v4/server.ts`: existing tool assembly and per-context ClickUp clients.
- `src/v4/tools/`: tool implementations and capability profiles.
- `src/v4/core/`: HTTP transport, resolver, cache and existing personal-mode OAuth verification.
- `src/team/`: team-only OAuth bridge, persistent grants, approval portal and isolated tools.
- `src/compat/`: 62 ClickUp plugin compatibility contracts, public API handlers, bulk adapters, and explicit parity gaps.
- `skills/clickup-team/`: packaged operating skill and generated input schemas, also available as an MCP resource.
- `docs/capabilities.md`: generated team tool reference. Rebuild with `npm run capabilities` after changing tools.
- `scripts/`: deployment launchers and build helpers.
- `deploy/`: hosting instructions. Coolify is the team deployment target.
- `test/`: Node test runner suites. `npm test` compiles TypeScript then runs them.

Team mode must never use the personal API token, expose upstream credentials, share resource caches between users, or enable tools for unapproved accounts.
