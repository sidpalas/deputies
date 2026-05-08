# Flue Persistence

## Why This Exists

Flue has two relevant state concepts:

- Agents own sandbox state, such as files written during a run.
- Sessions persist message history and conversation metadata inside an agent.

On Node.js, Flue stores sessions in memory by default unless a custom store is provided. That is not acceptable for this system because we need process restarts, multiple replicas, worker crash recovery, deploys, and UAT to preserve runner conversation state.

Therefore, the implementation must include a Postgres-backed Flue session store.

## What Flue Does On Cloudflare

Flue's Cloudflare build plugin generates one Durable Object class per webhook agent. Inside that generated entrypoint, it creates a default Flue session store backed by the Durable Object's SQLite storage.

The generated store is equivalent to:

```ts
function createDOStore(sql) {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS flue_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
  return {
    async save(id, data) {
      sql.exec(
        'INSERT OR REPLACE INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)',
        id,
        JSON.stringify(data),
        Date.now(),
      );
    },
    async load(id) {
      const rows = sql.exec('SELECT data FROM flue_sessions WHERE id = ?', id).toArray();
      if (rows.length === 0) return null;
      return JSON.parse(rows[0].data);
    },
    async delete(id) {
      sql.exec('DELETE FROM flue_sessions WHERE id = ?', id);
    },
  };
}
```

The Cloudflare entrypoint then passes this store as `defaultStore` when creating the Flue context. If Durable Object SQL storage is unavailable, it falls back to an in-memory store.

That confirms the right Node architecture: provide the same `SessionStore` contract, but backed by Postgres instead of Durable Object SQLite.

Flue's public `SessionStore` shape is:

```ts
export interface SessionStore {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
}
```

`SessionData` is Flue-owned serialized conversation state containing entries, leaf id, metadata, and timestamps. It should be stored opaquely.

## Two Kinds Of State

Do not collapse product state and Flue runtime state into one concept.

| State | Owner | Purpose |
|---|---|---|
| Product session state | Our `sessions`, `messages`, `runs`, `events`, `artifacts`, `sandboxes` tables | User-visible background-agent lifecycle |
| Flue session state | Custom Flue `SessionStore` table | Flue conversation/tool/task history used by the runner |

Product state is the source of truth for the app. Flue state is the source of truth for Flue's internal conversation continuity. Both are required.

## Required Table

The current implementation uses a dedicated table for Flue session data.

```txt
flue_sessions
  id text primary key
  data jsonb not null
  version int not null default 1
  created_at timestamptz not null
  updated_at timestamptz not null
```

The exact serialized `data` shape should be treated as Flue-owned. Store it opaquely and avoid querying inside it unless Flue exposes a stable contract.

Store rows by the exact `id` key Flue passes into `save`, `load`, and `delete`. Do not derive or parse the key in application code unless Flue exposes that key format as a stable public contract. The current table does not persist separate `agent_id`, `session_id`, or `app_session_id` metadata columns.

## Store Interface

The implementation should wrap Flue's session persistence interface in `runner-flue` or a nearby infrastructure module.

Conceptually:

```ts
class PostgresFlueSessionStore implements SessionStore {
  async save(id: string, data: SessionData): Promise<void>;
  async load(id: string): Promise<SessionData | null>;
  async delete(id: string): Promise<void>;
}
```

Use the actual Flue SDK types during implementation.

Rules:

- Keep the table and adapter isolated from product-domain modules.
- Treat Flue data as opaque serialized runtime state.
- Preserve Flue task/child session state exactly as Flue stores it.
- Write through transactions where Flue permits it.
- Add integration tests proving history survives app restart.

## Agent IDs And Session IDs

Use stable identifiers so Flue can resume correctly.

Recommended MVP mapping:

```txt
Flue agent id      = product session id
Flue session id    = default
Product session id = sessions.id
```

If we later support multiple conversations inside one sandbox, introduce named Flue sessions:

```txt
agentId = sessions.id
flueSessionId = external thread id or logical subthread id
```

## Relationship To Sandbox Persistence

Flue session persistence does not preserve sandbox files. Sandbox state is separate.

Durable sandbox continuity requires:

- persisted provider sandbox ID in `sandboxes`;
- provider reconnect support;
- persistent filesystem, snapshot/restore, or repo re-sync policy;
- health checks before reuse.

The worker must restore both layers before running a follow-up:

```txt
load product session
connect or create sandbox
initialize Flue with PostgresFlueSessionStore
open stable Flue session
run prompt
```

## Node And Multi-Replica Behavior

Node in-memory Flue sessions are only valid for local experiments. Production and CI should always configure the Postgres store.

Rules:

- `RUN_MODE=all` still uses Postgres Flue store.
- `RUN_MODE=worker` uses Postgres Flue store.
- Tests should fail if production config accidentally uses in-memory Flue sessions.
- Local development may opt into memory only with explicit config such as `FLUE_SESSION_STORE=memory`.

Recommended default:

```txt
FLUE_SESSION_STORE=postgres
```

## Testing Requirements

Unit tests:

- save/load/delete behavior.
- key mapping for agent/session IDs.
- serialization round trip.

Integration tests:

- create app session and run fake or real minimal Flue prompt.
- restart app/runner process.
- run follow-up against same product session.
- assert Flue history was loaded, not reset.

Concurrency tests:

- two workers cannot mutate the same Flue session concurrently because the product run lease prevents it.

UAT tests:

- built artifact starts, runs a session, restarts, continues same session.

## Current Implementation Notes

- `apps/api/src/runner-flue/session-store.ts` implements Flue's `SessionStore` interface with Postgres.
- `save`, `load`, and `delete` use the exact opaque store key provided by Flue.
- `RealFlueAgentFactory` uses the configured session store as both `defaultStore` and `persist`.
- During cancellation, `FlueRunner` snapshots and restores the active Flue session to avoid persisting partial aborted turns.

The architecture assumes a custom Postgres Flue session store is required for durable deployments.
