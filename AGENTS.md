# ClickUp Team maintenance

- The team entry point is `src/team/index.ts`. Shared tools are assembled in `src/v4/server.ts`.
- `src/compat/catalog.ts` preserves the 62 ClickUp plugin input contracts. Implementations live in the other `src/compat/` modules. Compatibility contracts are not evidence of full upstream functionality.
- Keep `compatibilityGaps` and `compatibilityNotes` in `src/compat/tools.ts` accurate. Never add a fake endpoint, simulated success, or substitute ClickUp object to conceal an unsupported feature.
- Team tools must use the authenticated, approved user's OAuth credential through `TeamTools.context`. Never instantiate a legacy client that can fall back to `CLICKUP_API_TOKEN`. Preserve request-local resource caches and credential-scoped rate budgets.
- Preserve HTTP policy enforcement and explicit confirmation for irreversible deletes and merges. Do not weaken the core profile into membership or webhook administration.
- Changes to tool schemas must update the profile table and discovery tests. Run `npm run capabilities` to regenerate the packaged schemas and Markdown reference.
- `skills/clickup-team/SKILL.md`, its references, and `docs/capabilities.md` ship in npm and Docker distributions. `clickup-team://skill` exposes the guidance through MCP. Keep initialization instructions useful without requiring a local skill installation.
- Verify the compatibility suite and the full Linux suite with an isolated test database before deployment. Do not use production ClickUp content for write tests without an explicitly authorized test scope.
- A repository update does not refresh an existing deployment or client tool cache. Verify the deployed version and tools, then refresh the custom plugin.
