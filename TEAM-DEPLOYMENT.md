# ClickUp team deployment

Endpoint: https://clickup-api.185.227.135.69.sslip.io/mcp

Team mode runs `node scripts/coolify-start.mjs` with `MCP_MODE=team`.
Required runtime settings: `DATABASE_URL`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`,
`TOKEN_ENCRYPTION_KEY` (base64-encoded 32 random bytes), `TEAM_OWNER_CLICKUP_USER_ID=61768248`,
`MCP_PUBLIC_URL=https://clickup-api.185.227.135.69.sslip.io/mcp`, `PORT=10000`.
Do not put these settings in build arguments or commit their values.

The ClickUp OAuth callback is `/auth/clickup/callback`. Only ClickUp OAuth identifies users.
Auth0 and `CLICKUP_API_TOKEN` are ignored by team mode. Personal/stdio mode is preserved.
The Docker build runs the existing offline suite. CI also provisions PostgreSQL for the
security integration suite. Run that suite with `TEAM_TEST_DATABASE_URL` pointing to an isolated
test database; it creates and removes a random schema and never uses live ClickUp credentials.

## Teammate onboarding

1. Add the endpoint as an OAuth MCP connection in ChatGPT or Codex. Sign in on ClickUp’s own
   page and authorize the workspaces you want to use. Your account starts pending.
2. Ask Joshua to approve the ClickUp user ID shown on the approval page. After approval,
   reconnect from your client and choose a default workspace on the consent page.

`workspaces` lists your authorized workspaces. `workspace_id` selects another workspace for
a tool call. Every operation uses your own token and ClickUp permissions. Server file uploads,
membership/guest/webhook administration, and Docs writing are unavailable. Deletions require
your explicit approval and the `confirm: true` argument.

Visit `/account` to see connection status or disconnect. Disconnect deletes the stored ClickUp
credential and revokes all local sessions and grants. Reauthorize on ClickUp to change workspace
permissions. ClickUp OAuth tokens currently have no upstream refresh flow.

## Joshua’s approval procedure

Sign in at `/admin` through ClickUp. Confirm the teammate’s immutable ClickUp user ID with them,
then approve that ID. Email and display names never grant owner status. The teammate must
reconnect after approval. Disable immediately removes the saved credential and revokes access.

## Storage and recovery

The PostgreSQL service is private with persistent storage and no public database port. Upstream
tokens use AES-256-GCM; local access/refresh tokens and browser sessions are hashed. Preserve
the encryption key separately from database dumps. Changing or losing it prevents existing
credentials from being decrypted, and startup refuses an incompatible key.

Install `scripts/backup-team.sh` on the host as a root-only executable. Schedule it daily.
It writes root-only dumps under `/data/backups/clickup-api` and retains seven days.
Use `scripts/verify-team-restore.sh /data/backups/clickup-api/clickup-team-<timestamp>.dump`
to restore into a temporary database and verify the authentication tables before rollout.
Both scripts target the Coolify PostgreSQL container recorded in this deployment.

## Release gates and rollback

Automated tests are insufficient for acceptance. Before approving teammates, verify real sign-in,
consent, refresh, disconnect, reconnect, a permitted read, and a permission denial in both ChatGPT
and Codex. Verify concurrent isolation using Joshua and a real approved teammate with different
workspace/private-list access. Live writes require explicitly named disposable test resources.

Keep the existing discovery-only image and Render deployment available until those checks pass.
Rollback uses the pinned discovery-only image or `MCP_MODE=discovery-only`; never enable a
shared personal token for teammates. Remove the application’s old personal token and Auth0
settings only after acceptance. Do not delete the Auth0 tenant or change unrelated services.

Transactions expire after ten minutes, authorization codes after two minutes, MCP access after
15 minutes, and rotating refresh families after 30 days. Reusing a refresh token revokes its
entire family. Logs contain operational messages only; audit records contain action names and
account/workspace identifiers, without task content, authorization codes, or tokens.
