---
name: clickup-team
description: Use the self-hosted ClickUp Team MCP for workspace operations, task creation and updates, bulk task workflows, hierarchy, comments, Docs, chat, fields, and time tracking. Inspect capability metadata before assuming parity with the official ClickUp plugin.
---

# ClickUp Team

Use the selected `clickup_team` MCP connection. The hosted service is `https://clickup-api.185.227.135.69.sslip.io/mcp`. Its personal plugin is named **ClickUp Team**. Each teammate connects their own ClickUp account and requires owner approval. Never substitute the public ClickUp plugin or another account silently.

The server advertises 62 `clickup_*` compatibility contracts alongside its existing name-based tools. Contract count does not establish complete functional parity. Read `clickup_get_schema` for implemented, limited, experimental, and unavailable operations.

## Discovery and routing

- Invoke exact tool identifiers from the client's live registry. Host prefixes vary. For example, a client may expose `mcp__clickup_team__clickup_get_task`. The stable server-facing name is `clickup_get_task`.
- Team mode provides `workspaces` to list authorized workspaces and the connection default. Use a digits-only `workspace_id` to select another authorized workspace.
- Use `clickup_get_workspace_hierarchy` or native `tree` to discover lists. Use `clickup_get_list` or `clickup_get_folder` for known names. Ambiguous names require an exact path or ID.
- Call `clickup_get_operators` before `clickup_execute_operator`. The only enabled pairs are `task.get_many`, `task.create_many`, `task.update_many`, `task.archive`, and `task.unarchive`.
- Full tool input schemas are packaged in [references/tools.json](references/tools.json). A client can also discover the `clickup-team://skill` MCP resource. Server initialization carries the shared operating instructions automatically.

## Workflows

| Request | Route |
|---|---|
| Find tasks by fields | `clickup_filter_tasks`. Follow `next_page` while `has_more`. |
| Find text or Docs | `clickup_search`. Follow `next_cursor` and report returned coverage. |
| Inspect task | `clickup_get_task`. Supply `include` sections or `expand_statuses` when needed. |
| Create task/subtask | Resolve list, assignees, and legal statuses. `clickup_create_task`, with `parent` for a subtask. |
| Update task | `clickup_update_task`. Omit untouched fields. |
| Bulk task work | Discover the operator, resolve explicit IDs, execute, and inspect every per-item outcome. |
| Task relationships | Dedicated add/remove tag, dependency, link, and additional-list tools. |
| Move task | `clickup_move_task`. Destination must support the current status. Read-back verifies the home list. |
| Comments | Read comments and replies before posting. Use `clickup_create_comment`. The task-comment alias is deprecated. |
| Docs | Search Docs, list pages, read pages, then create or update pages. Append/prepend when adding content. |
| Chat | List channels, read messages/replies, then send or react only as authorized. |
| Time | Current timer, start/stop, manual entry, time-entry report, or time-in-status tools. |
| Local attachment | Request a native upload ticket, then send exactly one multipart `attachment` file. |
| Small attachment | `clickup_attach_task_file` with base64 and filename, maximum 200 KB. |

## Input rules

- Dedicated tools use user-facing date strings. Calendar dates and times resolve in the authenticated ClickUp user's timezone. A missing timezone fails rather than guessing. Explicit millisecond epoch strings avoid local-time ambiguity.
- Dedicated task estimates are strings containing minutes. Bulk estimates are numeric milliseconds. Bulk estimate updates require `time_estimate_string` alongside the numeric value, with both null when clearing.
- Dedicated priorities are `urgent`, `high`, `normal`, or `low`. Update also accepts `none`. Bulk priorities are 1 through 4 or null.
- Assignees resolve from names, emails, `me`, or known IDs. `clickup_resolve_assignees` returns numeric IDs as strings. Field-specific schemas distinguish string and numeric IDs.
- Read custom-field definitions before writing or filtering. Dedicated values are strings, including JSON for complex field types. Unknown filter IDs fail before a request can silently lose its filters.
- The public API calls a Folder filter `project_ids` and a Space filter `space_ids`. The compatibility inputs remain `folder_ids` and `space_ids`.
- Multiple task tag filters use OR, applied locally over each scanned page. An empty matching page can still have `has_more:true`. Continue pagination.
- Custom task IDs are resolved to real IDs for operations that do not accept custom IDs, including merge.
- Bulk assignment replaces the assignee set. An empty `assignee_ids` array clears assignments. Bulk operations return partial results and are not atomic.
- Doc page content defaults to replacement. Use `content_edit_mode:append` or `prepend`, and provide boundary newlines. Empty content is rejected.
- Comments convert Markdown to ClickUp rich text. `[@Name](#user_mention#12345)` becomes a real user mention after membership validation. Markdown tables preserve their cells as fixed-width rows because ClickUp documents no rich-table segment format.
- Chat message/reply reads with reactions have a maximum page size of 25. Other chat reads allow up to 100.
- Time-in-status requires the corresponding ClickApp. Additional-list membership requires Tasks in Multiple Lists.
- Upload tickets are secrets, expire after five minutes, and are consumed once. They never expose the upstream credential. Maximum native upload size is 25 MB. Request a fresh ticket after failure or restart.

## Authorization and limitations

- Team mode rechecks account approval, credential validity, and authorized workspace at execution time. Every call uses that user's OAuth credential. It never falls back to the deployment's personal API token.
- Ask before irreversible deletion or merging. Supply `confirm:true` only after approval. The server also enforces this requirement. Deleting a list destroys its tasks. Merging consumes source tasks.
- Comments and chat posts communicate to other people. Send only within the user's authorized request.
- Do not retry an ambiguous write automatically. Read back the target first. Inspect per-item bulk failures before retrying individual items.
- Membership administration, webhook administration, and reading server-local files remain excluded from team mode.
- The four unavailable compatibility contracts are `clickup_search_reminders`, `clickup_update_reminder`, `clickup_list_document_page_attachments`, and `clickup_download_document_page_attachment`. They return explicit errors and perform no substitute action.
- `clickup_create_reminder` uses an existing experimental create-only integration. It is not listed in ClickUp's public specifications. Do not claim broad reminder parity.
- Search covers tasks and Doc names. Official plugin searches across dashboards, whiteboards, attachments, and workspace-wide chats cannot be reproduced through the documented public search interface. Unsupported types and filters fail explicitly.
- Task attachment downloads return URLs supplied in accessible task metadata. The public API adapter cannot mint the official plugin's private signed download links.
- Bulk operators are local workflows over public task endpoints. They do not call ClickUp's private Unified API. Quill delta descriptions, group-assignee mutations, private version events, and private scheduling metadata are not supported.
- The broader interface adds schema context cost. Native name-based tools remain available for compact workflows. Read-only profiles withhold compatibility writes.

## Examples

Server-facing tool names are shown below. Bind them to the selected client's live identifiers.

```json
{"tool":"clickup_get_task","arguments":{"task_id":"DEV-123","include":["description","custom_fields"],"expand_statuses":true}}
```

```json
{"tool":"clickup_create_task","arguments":{"list_id":"901234567890","name":"Review launch brief","assignees":["me"],"priority":"high","due_date":"2026-10-30","time_estimate":"60"}}
```

```json
{"tool":"clickup_get_operators","arguments":{"model_operators":["task.update_many"]}}
```

```json
{"tool":"clickup_execute_operator","arguments":{"model":"task","operator":"update_many","body":{"task_ids":["abc123","def456"],"priority":2,"time_estimate":7200000,"time_estimate_string":"2 hours"},"query":"{ids:task_ids,errors:errors}"}}
```

```json
{"tool":"clickup_update_document_page","arguments":{"document_id":"ad-1","page_id":"ad-2","content":"\n## Decision\nProceed with the agreed launch date.","content_edit_mode":"append","content_format":"text/md"}}
```

```json
{"tool":"clickup_add_time_entry","arguments":{"task_id":"abc123","start":"2026-10-22 09:00","duration":"1h 30m"}}
```

## Sources

- [ClickUp public API v2 specification](https://developer.clickup.com/openapi/clickup-api-v2-reference.json)
- [ClickUp public API v3 specification](https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml)
- [Task merge API](https://developer.clickup.com/reference/mergetasks)
- [Chat API](https://developer.clickup.com/docs/chat)

Refresh the live catalog after deployment or plugin tool refresh. Repository changes alone do not update a running server or an already-cached client catalog.
