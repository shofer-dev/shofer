# SaaS Platform Architecture & Phased Rollout

> **📐 Proposed.** This document describes a multi-tenant SaaS platform design that has
> not yet been built. It defines the tenancy model, database schema, services, and phased
> rollout plan for turning the current single-user development environment into a
> multi-tenant cloud development platform. No shipping code exists for the platform
> services (`user-console`, `resource-manager`) described here. The **agent layer is the
> exception**: the L2 orchestration agent is not a new agent implementation but the
> already-shipped host-agnostic Shofer core (`@shofer/core`) run headless and driven over
> Shofer's `AgentApi` transport — see [§5.3](#53-l2-agent-headless-shofer) and
> [`v3_architecture.md`](./v3_architecture.md).

## Table of Contents

1. [Goals & Scope](#1-goals--scope)
2. [Current Infrastructure](#2-current-infrastructure)
3. [Target Architecture](#3-target-architecture)
4. [Database Schema](#4-database-schema)
5. [Services](#5-services)
6. [Phased Rollout Plan](#6-phased-rollout-plan)
7. [Infrastructure Dependencies](#7-infrastructure-dependencies)

---

## 1. Goals & Scope

**North star.** The end state is a **native AI-agentic environment where agents do most of the
work to build _and run_ a software product**, and the human is involved the way a CEO/CTO (with
an Architect hat on demand) is: setting direction, owning trade-offs, and approving the
decisions that shouldn't be delegated — not operating the tooling. Agents **build** the product
(SDLC-triggered pipelines) and **operate** it (ops-triggered pipelines), coordinating with each
other and with the human through standard SDLC tools. The multi-tenant dev platform below is the
substrate this runs on; the agent layer ([§5.6](#56-agentic-pipelines--orchestration)) is
additive and removable (principles 9–10).

Concretely, transform the current single-user code-server development environment into a
multi-tenant SaaS platform where:

- **Multiple users** belong to **organizations** and can create or participate in multiple
  **projects** concurrently.
- **Projects** are the primary collaboration and namespacing primitive — like a shared
  Google Drive folder. A project groups workspaces and resources, and is the unit at which
  access permissions are defined. Users have roles within a project (`owner`, `readwrite`,
  `readonly`).
- **Workspaces** (code-server instances) live inside projects and are provisioned, started,
  stopped, and destroyed on-demand with resource limits (CPU, memory, storage).
- **Infrastructure resources** (filesystems, databases, S3 buckets, compute clusters) are
  provisioned via a unified abstraction, belong to a project, and can be mounted to
  workspaces.
- **Role-based access control** operates at two levels: organization-wide roles (Phase 0)
  and per-project roles (Phase 1) that govern who can view, edit, or manage project
  resources.
- **An orchestration agent** (L2 Agent) manages infrastructure through natural-language
  conversations, with approval workflows for dangerous operations. The L2 Agent is the
  shipped Shofer agent core (`@shofer/core`) run headless in the cluster and driven by
  `user-console` over Shofer's `AgentApi` transport — not a bespoke agent implementation
  (see [§5.3](#53-l2-agent-headless-shofer)).

**Each organization runs on its own k3s cluster**, giving hard _physical_ isolation between
organizations. Within a cluster, projects are Kubernetes namespaces (intra-org isolation).
Each cluster reuses the infrastructure already deployed (PostgreSQL → YugabyteDB, Redis,
MinIO, CephFS, ClickHouse, observability stack) as **org-global** services shared across
that org's projects. See [§2.1 Tenancy & service scope](#21-tenancy--service-scope).

### Design Principles

1. **Grow naturally** — introduce tables and services only when a concrete need arises.
2. **No premature complexity** — heavier infrastructure is introduced only when its absence
   causes real pain, at the phase that needs it (e.g. Keycloak in Phase 0 for multi-user auth;
   ClickHouse + NATS in Phase 4 for agent KPIs and the mesh).
3. **Go + Bazel** — all new backend services follow the existing tech stack convention.
4. **Shared database, separate services** — services communicate via HTTP APIs and share
   the same PostgreSQL database with clear table ownership boundaries.
5. **Extensible resource model** — a single `resources` base table with type-specific
   extension tables, so new resource types don't require schema migrations to the core.
6. **Reuse the agent core, don't rebuild it.** The L2 orchestration agent is the shipped
   host-agnostic Shofer core run headless and driven over `AgentApi`; its tools are MCP
   tools and its approval flow is Shofer's native permission engine. The platform builds a
   control plane _around_ the agent, never another agent loop.
7. **Audit at the trusted boundary.** What users and their agents do is recorded by the
   org-global platform services that sit on the request path (`llm-router`, `mcp-server`,
   `user-console`) — never by the workspace, which the end user can tamper with (see
   [§5.4](#54-agent-recording--audit-pipeline)).
8. **Single-writer per table.** Every table has exactly one owning service that writes it;
   any number of services may read it. Ownership is unambiguous, and there is no write
   contention or hidden cross-service coupling through shared mutable rows. The one carve-out
   is append-only telemetry sinks (multi-producer, immutable rows, zero mutation — see the
   `agent_activity_kpi` note in [§4.15](#415-agent-audit-trail-phase-4)). Ownership map in
   [§3 Communication Patterns](#communication-patterns).
9. **Agents are a strippable layer over a fully-manual platform.** The system is a complete,
   standard SDLC platform (GitLab + workspaces + resources + Grafana) that a human can drive
   entirely by hand; the agent automation sits on top and can be removed. **No agent is ever a
   hard dependency for a core operation, and every hard-gated agent action has a manual
   equivalent.** A global kill switch disables all agent workflows and reverts to pure manual
   operation with zero loss of function (the "Tesla autopilot" model — must stay drivable by
   hand, take over anytime, everything recorded). See [§5.6](#56-agentic-pipelines--orchestration).
10. **Don't replace the SDLC — work through it.** Agents act through the same standard tools a
    human engineer uses (GitLab issues for intent, MRs for changes, CI for delivery, Grafana
    for ops). Every agent action is therefore a native, inspectable artifact, which makes
    **transparency and takeover properties of the substrate, not features to build.** Corollary:
    don't invent proprietary state where a standard tool already exists.

---

## 2. Current Infrastructure

The following components are **already deployed** on the k3s cluster and will be reused:

| Component                      | Status                                 | Notes                                                                                   |
| ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------- |
| PostgreSQL 18                  | ✅ Deployed                            | DB: `arkware`, user: `admin`. Currently used by tools-backend for workspace tool state. |
| Redis 8                        | ✅ Deployed                            | Used by llm-router for caching/rate-limiting.                                           |
| MinIO                          | ✅ Available (disabled by default)     | S3-compatible object storage. Enabled in development.                                   |
| CephFS (Rook)                  | ✅ Deployed                            | Distributed filesystem with RWX, RWO, and RBD storage classes.                          |
| Loki + Mimir + Tempo + Grafana | ✅ Deployed                            | Observability stack (logs, metrics, traces). No ClickHouse.                             |
| Qdrant                         | ✅ Deployed                            | Vector store for RAG indexing.                                                          |
| code-server                    | ✅ Deployed                            | The IDE, currently single-user.                                                         |
| llm-router (Go)                | ✅ Deployed                            | LLM provider routing with composite models.                                             |
| mcp-server (Go)                | ✅ Deployed                            | MCP tool server for code-server.                                                        |
| tools-backend (Go) ✅ Deployed | Tool execution backend for MCP server. |
| rag-indexer (Go)               | ✅ Deployed                            | Codebase RAG indexing.                                                                  |

**Not yet deployed** (introduced in later phases):

| Component          | Phase    | Reason                                                                                                                                           |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keycloak           | Phase 0  | OIDC authentication for multi-user.                                                                                                              |
| ClickHouse         | Phase 4  | High-cardinality product KPIs/analytics over agent activity (see [§5.4](#54-agent-recording--audit-pipeline)).                                   |
| YugabyteDB         | Phase 4+ | Distributed, Postgres-compatible replacement for PostgreSQL once control-plane + audit write/storage volume outgrows a single node. Same schema. |
| NATS (+ JetStream) | Phase 4  | Single bus for the agent mesh (A2A) + cluster-event notifications ([§5.5](#55-the-agent-mesh-registration-discovery-a2a)).                       |

All of the above are **org-global** — one instance per organization cluster (§2.1).

### 2.1 Tenancy & Service Scope

Isolation is two-tier, and physical at the top:

- **Organization = its own k3s cluster.** Every organization runs on a dedicated cluster,
  so cross-organization isolation is _physical_ — separate clusters, separate databases,
  separate everything. No control plane, data store, or agent is ever shared across
  organizations, and an org's data never leaves its own cluster.
- **Project = a namespace** within the org's cluster. Users and Groups participate in
  Projects; intra-org isolation is namespace + RBAC. A project maps 1-1 to a Kubernetes
  namespace (see [§4.2](#42-projects-phase-1)).

Because cross-org isolation is physical, the multi-tenant access control in the schema is
about _intra-org_ authorization (which user/group may touch which project), never
cross-tenant data separation.

Services therefore have one of two scopes:

| Scope                                                              | Count   | Services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org-global** — one per cluster, shared by all the org's projects | 1 / org | `user-console` (+ the L2 headless-Shofer backend it drives, §5.3), `llm-router`, `mcp-server`/`tools-backend`, `resource-manager`, the **mesh control plane** (agent **registrar** + **NATS** bus, §5.5), the **pipeline orchestration** plane (**Temporal** + event-ingress adapters, §5.6), self-hosted **GitLab** (coordination system of record), and the platform data stores: **YugabyteDB** (control + audit + registry), **ClickHouse** (KPIs), Redis, Qdrant, MinIO, CephFS, and the observability stack (Mimir/Tempo/Loki/Grafana, incl. **Alertmanager** as an event source) |
| **Project-scoped** — per namespace                                 | N / org | **workspaces** (code-server + Shofer **L1** + the **arkware-orchestrator** mesh sidecar, §5.5; the MCP tool surface is served by the org-global `mcp-server`) and **user-provisioned resources** (project databases, S3 buckets, compute/services created via `resource-manager`)                                                                                                                                                                                                                                                                                                       |

The line between org-global platform data stores and project-scoped resources matters:
YugabyteDB, ClickHouse, Redis and Qdrant are **platform** infrastructure shared across the
org, whereas a _project's own_ provisioned database (`resource_sqldb`) or bucket
(`resource_s3`) is a per-namespace **resource** with its own lifecycle (see
[§4.4](#44-resources-phase-2)). "The platform's database" and "a user's database" are
different things at different scopes — this is what the "not necessarily the future ones"
caveat above refers to.

This scope split is also the backbone of the audit model ([§5.4](#54-agent-recording--audit-pipeline)):
the three services that record what users and agents do — `user-console`, `llm-router`,
`mcp-server` — are all org-global platform services that end users only reach through
defined APIs. The workspace, which the end user _can_ tamper with, is never a recorder.

### 2.2 Identity & Cluster Access (Keycloak → k3s)

Human identity flows from Keycloak into the cluster; workload identity does not (pods use k8s
ServiceAccounts, separate and unchanged). Two halves:

- **AuthN — OIDC on the kube-apiserver.** Each org cluster's kube-apiserver is configured for
  OIDC against **that org's Keycloak realm** (`--oidc-issuer-url` = the realm,
  `--oidc-client-id`, `--oidc-username-claim` = the Keycloak subject, `--oidc-groups-claim`). A
  user who authenticates to Keycloak — and exists in `users`, keyed by `keycloak_id` = the OIDC
  subject — can then present a token the API server trusts. This establishes _who they are_,
  not what they may do.
- **AuthZ — k8s RBAC reconciled from the DB.** `project_members` (Phase 1) is the source of
  truth. **user-console** — which owns membership and the namespace lifecycle — reconciles each
  membership into a per-namespace **RoleBinding** that references the user's `keycloak_id`. Add
  a member in the DB → a RoleBinding appears in `ns-<namespaceId>-…`; remove them → it is
  deleted. RBAC is a _projection_ of the DB, so the namespace boundary is enforced by k8s
  itself (defense-in-depth), not only at the app layer.

**Decision — user-facing k8s access is read-only.** Direct k8s _write_ access would let a user
`kubectl create` a Deployment/PVC in their namespace and **bypass `resource-manager` and the L2
provisioning approval + cost gate** (§5.3) — precisely what that gate exists to prevent. So the
RoleBinding grants **namespace-scoped read** (get/list/watch — inspect pods, logs, resources)
to _every_ project member; the `owner`/`readwrite`/`readonly` distinction that governs mutation
stays an **app-layer** capability enforced by user-console, and all mutation is mediated through
user-console/resource-manager/L2. Two ClusterRoles back this: `project-readonly` (bound to
members) and `project-admin` (used only by platform ServiceAccounts, never bound to a human).
Revisit only if power-users later need scoped `kubectl` write.

---

## 3. Target Architecture

```
┌─ Organization k3s cluster  (one per organization) ───────────────────────────┐
│                                                                              │
│   Ingress / Traefik                                                          │
│         │                                                                    │
│         ▼                                                                    │
│   ┌──────────────┐   AgentApi (HTTP/SSE): startTask · ask · respondToAsk     │
│   │ user-console │ ───────────────────────────────────────────┐             │
│   │ control plane│ ◀──── events · approvals ───────────────┐   │             │
│   │  + UI + audit│                                         │   ▼             │
│   └──┬────────┬──┘                                    ┌─────────────────┐    │
│      │        │ HTTP                                  │  L2 agent        │    │
│  ┌───▼───┐    │                                       │  headless Shofer │    │
│  │ res.  │    │                                       │  (@shofer/core)  │    │
│  │ mgr   │    │                                       └───────┬─────────┘    │
│  └───┬───┘    │                                       MCP tools│             │
│      │        ▼                                               ▼              │
│      │  ┌──────────────┐   LLM + MCP (L1 & L2)   ┌───────────────────────┐   │
│      │  │  llm-router  │◀────────────────────────│ mcp-server/tools-backend│  │
│      │  └──────┬───────┘                         └───────────┬───────────┘   │
│      │         │ records: conversation narration             │ records: tool │
│      ▼         │                                             │ ground truth   │
│  project       ▼                                             ▼                │
│  namespaces  ┌───────────────────────────────────────────────────────────┐   │
│  ┌─────────┐ │ YugabyteDB (control + structured audit)  ·  MinIO/S3 (blobs)│  │
│  │workspace│ │ ClickHouse (KPIs / analytics)  ·  Mimir/Tempo (ops + traces)│  │
│  │  (L1)   │─│ Redis · Qdrant · CephFS                                     │  │
│  │ Shofer  │LLM+MCP────────────────────────────────────────────────────────┘  │
│  └─────────┘                                                                  │
│                                                                              │
│  Trusted recorders (end user cannot tamper): user-console · llm-router ·     │
│  mcp-server. Workspaces (L1) are never recorders.                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Service Responsibilities

All services below are **org-global** (one per cluster, §2.1).

| Service                      | Language                                   | Port | Owns                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **user-console**             | Go                                         | 8000 | User-facing API + UI; control plane for workspaces, chat, notifications; **drives the L2 agent over `AgentApi`**; writes control-plane + audit rows                     |
| **resource-manager**         | Go                                         | 8006 | Infrastructure provisioning: k8s workloads, S3 buckets, filesystems                                                                                                     |
| **L2 backend**               | TS (`@shofer/core`)                        | 5111 | Headless Shofer executor pool; the agent loop driven by user-console over `AgentApi` (§5.3)                                                                             |
| **agent registrar**          | Go                                         | 5120 | Mesh control plane: agent registration, health, tier/scope/trust-class assignment, scoped-credential issuance, discovery (§5.5)                                         |
| **agent-mesh** (plugin)      | TS (Shofer plugin)                         | —    | Pure-JS NATS mesh participant: inbound notification delivery (`ctx.agent.notify`) + telemetry + `mesh_publish`/`mesh_subscribe` tools (§5.5–§5.6). Loadable on any node |
| **temporal-runner** (plugin) | TS (Shofer plugin, native `@temporalio/*`) | —    | Temporal activity worker: pulls tagged tasks, drives Shofer via `ctx.agent.spawn` (§14), + introspection tools (§5.6). Loaded on runner nodes                           |
| **NATS**                     | —                                          | 4222 | Single bus: event ingress (§5.6) + A2A + cluster-event notifications (§5.5); real-time telemetry/token side-channels (kept out of Temporal history)                     |
| **Temporal**                 | —                                          | 7233 | Durable pipeline orchestration: deterministic workflows, retries/timeouts, human-approval gates (signals), capability-tagged runner pool (§5.6)                         |
| **event-ingress**            | Go/TS                                      | —    | Stateless adapters normalizing sources (GitLab/Alertmanager webhooks, cron) onto NATS, and starting Temporal workflows from trigger rules (§5.6)                        |
| llm-router (existing)        | Go                                         | 3000 | LLM provider routing; **records conversation narration** (§5.4)                                                                                                         |
| mcp-server (existing)        | Go                                         | 3001 | MCP tool server for L1 & L2 + **A2A gateway** (authz + audit of mesh tool calls, §5.5); **records tool-call ground truth** (§5.4)                                       |
| tools-backend (existing)     | Go                                         | 8001 | Tool execution backend for mcp-server                                                                                                                                   |

### Communication Patterns

1. **Synchronous**: user-console → resource-manager via HTTP (workspace creation, resource
   provisioning, state queries).
2. **Agent control plane (intra-agent)**: user-console → its L2 backend over Shofer's
   `AgentApi` transport (HTTP/SSE) — start/message/cancel a task, stream assistant output and
   tool calls, surface `ask` approvals and reply with `respondToAsk`. Same transport Shofer
   Nodes uses, so _vertical_ scaling of the L2 backend comes from the existing
   `NodeRegistry`/`ExecutorPool` (§5.3). `AgentApi` never connects two _different_ agents.
3. **Agent mesh (agent-to-agent)**: L2↔L1 and all future agent-to-agent traffic go over the
   mesh (§5.5) — a NATS bus + registrar + A2A MCP tools at the `mcp-server` gateway, with
   three paradigms (sync req/resp, async req/resp via `agent_messages`, async notifications).
   This is _horizontal_ and distinct from #2.
4. **Shared database, single-writer per table** (design principle 8): every table has exactly
   one owning writer; any service may read any table. Ownership map:

    | Owner (sole writer)  | Tables                                                                                                                                                                |
    | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | **user-console**     | identity (Phase 0), `projects`, `project_members`, `workspaces`, `tasks`, `agent_approvals`, `notifications`, `observability_dashboards`, `pipeline_triggers` (§4.17) |
    | **resource-manager** | `resources` + all `resource_*` extensions, `workspace_resources`, `resource_versions`, `snapshots`                                                                    |
    | **llm-router**       | `agent_conversation_turns` (§4.15)                                                                                                                                    |
    | **mcp-server**       | `agent_tool_calls` (§4.15), `agent_messages` (§4.16, as the A2A gateway)                                                                                              |
    | **agent registrar**  | `agent_registry` (§4.16)                                                                                                                                              |

    The one carve-out is the append-only KPI sink `agent_activity_kpi` (§4.15) — a
    multi-producer telemetry stream with immutable, source-tagged rows (no shared mutation).

5. **Recording** (§5.4): `llm-router` and `mcp-server` sit on the request path and record
   what agents do; `user-console` records control-plane state and approvals. Recording
   never depends on the (tamperable) workspace.
6. **Event-driven** (Phase 4+): resource-manager and others publish cluster events onto the
   NATS bus; arkware-orchestrator delivers them to subscribed L1 agents (§5.5) and
   user-console consumes them for real-time UI updates.

---

## 4. Database Schema

The schema is introduced incrementally across phases. Below is the complete target schema,
annotated with the phase in which each table is introduced.

### 4.1 Identity & Access (Phase 0)

```sql
-- Organizations are namespaces for users. A "Public" org holds unaffiliated users.
CREATE TABLE organizations (
    organization_id  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(255) NOT NULL UNIQUE,
    display_name     VARCHAR(255),
    description      TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Users belong to exactly one organization. Authenticated via OIDC (Keycloak).
CREATE TABLE users (
    user_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID         NOT NULL REFERENCES organizations(organization_id),
    username         VARCHAR(255) NOT NULL,
    email            VARCHAR(255),
    display_name     VARCHAR(255),
    keycloak_id      VARCHAR(255) UNIQUE,  -- OIDC subject claim
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, username)
);

-- Groups are sets of users within an organization.
CREATE TABLE groups (
    group_id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID         NOT NULL REFERENCES organizations(organization_id),
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);

CREATE TABLE group_members (
    group_id         UUID         NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    user_id          UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    joined_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- RBAC: roles bundle privileges; assigned to users or groups.
CREATE TABLE roles (
    role_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID         NOT NULL REFERENCES organizations(organization_id),
    name             VARCHAR(100) NOT NULL,
    description      TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);

CREATE TABLE privileges (
    privilege_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(100) NOT NULL UNIQUE,
    description      TEXT
);

CREATE TABLE role_privileges (
    role_id          UUID         NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    privilege_id     UUID         NOT NULL REFERENCES privileges(privilege_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, privilege_id)
);

CREATE TABLE user_roles (
    user_id          UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role_id          UUID         NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE group_roles (
    group_id         UUID         NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    role_id          UUID         NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, role_id)
);
```

### 4.2 Projects (Phase 1)

Projects are the primary collaboration and namespacing primitive. A project groups
workspaces and resources together and is the unit at which access permissions are defined.
Think of a project as a shared Google Drive folder: the creator is the owner, and they can
invite other users with `readwrite` or `readonly` roles.
At the infrastructure level, **a project maps 1-1 to a Kubernetes namespace**. All
resources (Deployments, PVCs, Services, etc.) created for a project live in that namespace.
This provides hard isolation between projects at the k8s layer. The namespace name is
prefixed with a stable, generated **namespace id** — assigned at project creation and
user-agnostic — to avoid collisions (e.g., `ns-<namespaceId>-<project-slug>`). Because the id
is decoupled from both the owner and the mutable project name, existing k8s resources remain
addressable even if ownership changes or the project is renamed. The human-readable context —
the **owning user name** and the **project name** — is attached as namespace **annotations**
(not baked into the name), so it stays discoverable and can be updated freely without breaking
addressability; the stable ids (`owner_user_id`, `project_id`) are attached as **labels** for
selection. A special `default` project/namespace is created at bootstrap for the initial user,
but can be deleted later.

Every workspace and every resource belongs to exactly one project. This means:

- **Namespacing**: resource names need only be unique within a project, not globally.
- **Collaboration**: multiple users can work on the same set of resources.
- **Access control**: permissions are checked at the project level — a user with
  `readwrite` on a project can modify any resource in it; `readonly` can view but not
  modify; `owner` can also delete resources and manage members.

```sql
-- Projects namespace resources and workspaces, and are the collaboration unit.
CREATE TABLE projects (
    project_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID         NOT NULL REFERENCES organizations(organization_id),
    name             VARCHAR(255) NOT NULL,
    namespace        VARCHAR(63)  NOT NULL UNIQUE,  -- k8s namespace: ns-<namespaceId>-<slug> (owner/project names ride as k8s annotations)
    description      TEXT,
    created_by       UUID         NOT NULL REFERENCES users(user_id),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);
CREATE INDEX idx_projects_org ON projects(organization_id);

-- Project membership with roles. The creator is auto-assigned 'owner'.
-- Roles: owner (full control + member management), readwrite (create/modify resources),
--        readonly (view only).
CREATE TABLE project_members (
    project_id       UUID         NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    user_id          UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role             VARCHAR(20)  NOT NULL DEFAULT 'readonly',
    added_by         UUID         REFERENCES users(user_id),
    added_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id),
    CONSTRAINT check_project_role CHECK (role IN ('owner', 'readwrite', 'readonly'))
);
```

**Project role semantics:**

| Role        | View resources | Create/modify resources | Delete resources |          Manage members           |
| ----------- | :------------: | :---------------------: | :--------------: | :-------------------------------: |
| `owner`     |       ✅       |           ✅            |        ✅        | ✅ (invite, change roles, remove) |
| `readwrite` |       ✅       |           ✅            |        ❌        |                ❌                 |
| `readonly`  |       ✅       |           ❌            |        ❌        |                ❌                 |

**Access granularity is the project/namespace (§4.6):** project roles are the _only_ access
layer — projected onto k8s namespace RBAC for k8s-object resources and backed by provider-native
auth for non-k8s resources. A generic per-resource privilege layer is **deferred** (it aligns
with neither k3s RBAC nor the providers); when different access to one resource is genuinely
needed, the answer is a separate project/namespace.

### 4.3 Workspaces (Phase 1)

```sql
-- A workspace maps 1-1 to a code-server instance (k8s Deployment).
-- Every workspace belongs to a project; the user_id is the creator/owner.
CREATE TABLE workspaces (
    workspace_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID         NOT NULL REFERENCES projects(project_id),
    user_id          UUID         NOT NULL REFERENCES users(user_id),
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    state            VARCHAR(50)  NOT NULL DEFAULT 'pending',
    workspace_root   VARCHAR(512) NOT NULL DEFAULT '/home/coder/workspace',
    max_cpu_cores    NUMERIC(10,2),
    max_memory_mb    BIGINT,
    compute_id       VARCHAR(64),   -- k8s deployment name (set by resource-manager)
    compute_name     VARCHAR(255),
    error_message    TEXT,
    metadata         JSONB         NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    last_login       TIMESTAMPTZ,
    CONSTRAINT check_workspace_state CHECK (state IN (
        'pending', 'starting', 'creating', 'running', 'restarting',
        'stopping', 'stopped', 'destroying', 'error', 'destroyed'
    ))
);
CREATE INDEX idx_workspaces_project ON workspaces(project_id);
CREATE INDEX idx_workspaces_user    ON workspaces(user_id);
CREATE INDEX idx_workspaces_state   ON workspaces(state);
CREATE INDEX idx_workspaces_name    ON workspaces(name);
```

**Workspace state machine:**

```
pending ──▶ starting ──▶ creating ──▶ running ──▶ stopping ──▶ stopped
    │           │             │           │            │
    └──────▶ error ◀──────────┴───────────┴────────────┘
                │
                ▼
          destroying ──▶ destroyed
```

### 4.4 Resources (Phase 2)

```sql
-- Base resource table. All resource types share this with type-specific extensions.
-- Every resource belongs to a project; names are unique within (project, type, provider).
CREATE TABLE resources (
    resource_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id           UUID         NOT NULL REFERENCES projects(project_id),
    resource_type        VARCHAR(50)  NOT NULL,
    provider             VARCHAR(50)  NOT NULL,
    name                 VARCHAR(255) NOT NULL,
    description          TEXT,
    external_id          VARCHAR(255),    -- provider-specific ID (k8s deployment name, etc.)
    state                VARCHAR(50)  NOT NULL DEFAULT 'pending',
    config               JSONB        NOT NULL DEFAULT '{}',
    owner_id             UUID         NOT NULL REFERENCES users(user_id),
    parent_resource_id   UUID,            -- for hierarchical resources (service → children)
    current_version_id   UUID,            -- FK to resource_versions (Phase 4)
    supports_versioning  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, resource_type, provider, name),
    CONSTRAINT check_resource_type CHECK (resource_type IN (
        'filesystem', 'sqldb', 's3', 'container', 'compute', 'service'
    )),
    CONSTRAINT check_resource_state CHECK (state IN (
        'pending', 'starting', 'creating', 'running', 'stopped', 'stopping',
        'removing', 'removed', 'error', 'healthy', 'unhealthy'
    ))
);
CREATE INDEX idx_resources_project ON resources(project_id);
CREATE INDEX idx_resources_type    ON resources(resource_type);

CREATE INDEX idx_resources_owner   ON resources(owner_id);
CREATE INDEX idx_resources_state   ON resources(state);
CREATE INDEX idx_resources_parent  ON resources(parent_resource_id);
```

#### Extension: Container / Compute

```sql
CREATE TABLE resource_container (
    resource_id      UUID         PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
    service_name     VARCHAR(255),    -- grouping identifier for multi-component services
    container_id     VARCHAR(64),
    image            VARCHAR(512),
    command          TEXT[],
    entrypoint       TEXT[],
    environment      JSONB,
    labels           JSONB,
    ports            JSONB,
    volumes          JSONB,
    cpu_cores        NUMERIC(10,2),
    memory_mb        INTEGER,
    memory_high_mb   INTEGER,         -- cgroups soft limit (throttle threshold)
    blkio_weight     INTEGER,
    restart_policy   VARCHAR(50)      -- Always (default), OnFailure, Never
);
```

#### Extension: Compute (k8s-specific fields)

```sql
CREATE TABLE resource_compute (
    resource_id      UUID         PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
    image            VARCHAR(512) NOT NULL,
    service_name     VARCHAR(255),
    replicas         INTEGER      NOT NULL DEFAULT 1,
    workload_kind    VARCHAR(50)  NOT NULL DEFAULT 'deployment',  -- deployment | statefulset
    cpu_cores        NUMERIC(10,2),
    memory_mb        INTEGER,
    memory_high_mb   INTEGER,
    blkio_weight     INTEGER,
    blkio_read_bps   BIGINT,
    blkio_write_bps  BIGINT,
    network_rx_bps   BIGINT,
    network_tx_bps   BIGINT
);
```

> **No `network` resource.** k3s has no user-provisioned "network" object (Docker-style
> driver/subnet/gateway don't map — every pod is on one flat cluster network). Networking
> intent is realized without a tenant resource: the **project namespace** gives automatic
> intra-project connectivity, **platform-managed NetworkPolicy** does isolation + egress
> lockdown (§5.4), and **Services** do discovery.

#### Extension: Filesystem

```sql
CREATE TABLE resource_filesystem (
    resource_id      UUID         PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
    driver           VARCHAR(50)  NOT NULL DEFAULT 'local',
    driver_opts      JSONB,
    scope            VARCHAR(50)  NOT NULL DEFAULT 'local',  -- local | global
    labels           JSONB,
    max_size_bytes   BIGINT,
    external_ids     JSONB        -- provider-specific IDs (PVC name, VFS ID, etc.)
);
```

#### Extension: S3 (Object Storage)

```sql
CREATE TABLE resource_s3 (
    resource_id         UUID         PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
    bucket_name         VARCHAR(255) NOT NULL,
    region              VARCHAR(50)  NOT NULL DEFAULT 'us-east-1',
    endpoint            VARCHAR(512),
    access_key          VARCHAR(255),    -- s3-proxy credentials (not backend MinIO keys)
    secret_key          VARCHAR(255),
    versioning_enabled  BOOLEAN      NOT NULL DEFAULT FALSE,
    max_size_bytes      BIGINT,
    max_objects         BIGINT
);
```

#### Extension: SQL Database

```sql
CREATE TABLE resource_sqldb (
    resource_id           UUID         PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
    database_name         VARCHAR(255) NOT NULL,
    host                  VARCHAR(255) NOT NULL,
    port                  INTEGER      NOT NULL,
    username              VARCHAR(255),
    max_connections       INTEGER
);
```

### 4.5 Workspace-Resource Mounting (Phase 2)

```sql
-- N:N relationship: resources mounted to workspaces.
CREATE TABLE workspace_resources (
    workspace_id     UUID         NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    resource_id      UUID         NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,
    mount_point      VARCHAR(512),
    mount_options    JSONB        NOT NULL DEFAULT '{}',
    read_only        BOOLEAN      NOT NULL DEFAULT FALSE,
    connection_info  JSONB,       -- service connection details for tools-backend discovery
    mounted_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, resource_id)
);
```

**Deletion semantics:**

- Workspace deleted → mount entries CASCADE-removed.
- Resource deleted while mounted → RESTRICT (must unmount first).

### 4.6 Resource RBAC (Phase 3)

Access control is **per-project / per-namespace**, aligned with what k3s can actually enforce.
There is **no generic per-resource privilege layer** — it is deferred (see below).

Enforcement is layered by _what backs the resource_, and each layer already enforces at the
real boundary:

1. **Project-level roles** (Phase 1): `owner`, `readwrite`, `readonly` in `project_members` —
   the single access layer. Projected onto **k8s namespace RBAC** for k8s-object resources
   (PVC/filesystem, Deployment/compute, Service): a member gets namespace-scoped k8s read, and
   mutation is app-mediated by user-console per the member's role (§2.2). This is the k3s-native
   granularity — RBAC scopes to a namespace + verb + resource-_type_; `resourceNames` cannot
   restrict list/watch/create, so per-object ACLs are not practical in vanilla RBAC.
2. **Provider-native auth** for **non-k8s resources** (S3 bucket → per-bucket access keys; SQL
   database → per-DB grants). Per-resource access, where it is genuinely needed, is enforced by
   the provider's own credential/grant model — not a bespoke ACL table.

**Deferred — generic per-resource privileges.** A cross-cutting `resource_privileges` table
(fine-grained overrides such as granting one `readonly` member `write` on a single filesystem)
is **not built for now**. It aligns with neither enforcement layer — k3s cannot enforce per-object
RBAC, and non-k8s providers already have their own auth — so it would be an app-layer-only shadow
authz with "most-permissive-wins" reconciliation: extra complexity, weaker enforcement, larger
audit surface. When a use case genuinely needs different access to one resource, the answer is
**project decomposition** (put it in its own project/namespace). The table shape is retained here
as a future option only:

```sql
-- DEFERRED (not in Phase 3). Retained as a future option; see rationale above.
-- Dynamic per-resource privileges, assignable to users/groups/orgs.
CREATE TABLE resource_privileges (
    resource_id      UUID         NOT NULL REFERENCES resources(resource_id) ON DELETE CASCADE,
    grantee_type     VARCHAR(20)  NOT NULL,  -- user | group | organization
    grantee_id       UUID         NOT NULL,
    privilege        VARCHAR(50)  NOT NULL,  -- read | write | admin | mount
    granted_by       UUID         NOT NULL REFERENCES users(user_id),
    granted_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (resource_id, grantee_type, grantee_id, privilege)
);
```

### 4.7 Resource Limits (Phase 3)

Limits are set at the **project level** and enforced by k3s as a **ResourceQuota** on the
project's namespace — the k3s-native mechanism (CPU/memory/storage requests, PVC and pod
counts). This is the single enforcement level; there are no separate user/group/org limit
levels, because the namespace is the boundary k3s enforces.

The platform sets a project's total quota from the **org's plan** when the namespace is created.
**Within that quota, the project owner manages and distributes capacity internally** across the
project's workspaces — via per-pod requests/limits on each workspace Deployment (already carried
by `workspaces.max_cpu_cores` / `max_memory_mb`, §4.3), optionally with a namespace `LimitRange`
for defaults/ceilings. The DB row is the desired state; user-console reconciles it into the
namespace `ResourceQuota` (and per-workspace limits), just as it reconciles RBAC (§2.2).

```sql
-- Per-project quota → reconciled into a k8s ResourceQuota on the project's namespace.
CREATE TABLE resource_limits_project (
    project_id       UUID         NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    resource_type    VARCHAR(100) NOT NULL,  -- cpu, memory, storage, pods, pvcs, …
    limit_type       VARCHAR(100) NOT NULL,  -- requests, limits, count, max_size_mb, …
    limit_value      BIGINT       NOT NULL,
    PRIMARY KEY (project_id, resource_type, limit_type)
);
```

Internal distribution to workspaces uses the existing `workspaces.max_cpu_cores` /
`max_memory_mb` fields (owner-set) — no separate per-workspace limits table is needed for the
compute case; a namespace `LimitRange` covers per-pod defaults.

### 4.8 Agent Tasks & Approvals (Phase 4)

L1 (in-workspace coding) and L2 (cluster infra orchestration) are **the same engine in two
deployment shapes** — `@shofer/core`, run in the workspace pod (L1) or as an org-global
headless executor pool (L2). Their unit of work is a Shofer **task**, so the `tasks` table
holds only the **control-plane** rows the platform needs for its UI and audit; it does _not_
hold the conversation transcript or the
raw tool stream (those are the audit trail, [§4.15](#415-agent-audit-trail-phase-4), written
by the trusted recorder services, [§5.4](#54-agent-recording--audit-pipeline)).

The single identifier that ties every store together is **`task_id`** — the Shofer task id
(uuidv7), already the primary identity in `@shofer/core` (`metadata.taskId`). There is no
separate `chat_session_id` or `conversation_id`. `llm-router` already threads this id (today
under the legacy wire name `conversation_id`, with `parent_conversation_id` /
`root_conversation_id` for delegation hierarchies); renaming those wire fields to `task_id` /
`parent_task_id` / `root_task_id` is the accompanying codebase change (a global rename of
`conversationId`).

> **TODO (codebase — `conversationId` → `taskId` global rename).** Rename the wire field and
> its symbols across `llm-router` (Go) and `@shofer/core` (TS) — ~19 files: the request-body
> field `conversation_id` (+ `parent_conversation_id` / `root_conversation_id`), the OTel span
> attributes, and the `shofer` provider that injects it. Rename both sides in one change and
> ship them together — **no rolling migration or backward-compat alias**; simplicity over a
> deprecation window.

```sql
-- One row per agent task (L1 or L2). Control-plane metadata only — no messages.
-- task_id is the Shofer task id (uuidv7) — the same value used as the key in every store.
CREATE TABLE tasks (
    task_id          UUID         PRIMARY KEY,          -- = Shofer task id (uuidv7)
    agent            VARCHAR(10)  NOT NULL DEFAULT 'l2',  -- l1 | l2 (deployment shape)
    user_id          UUID         REFERENCES users(user_id),
    project_id       UUID         REFERENCES projects(project_id),   -- L2 acts within a project context
    workspace_id     UUID         REFERENCES workspaces(workspace_id),
    parent_task_id   UUID         REFERENCES tasks(task_id),   -- L2→L1 delegation
    root_task_id     UUID         REFERENCES tasks(task_id),   -- top of the delegation tree
    executor_id      VARCHAR(64),  -- which headless-Shofer node owns the task (L2)
    title            VARCHAR(255),
    status           VARCHAR(50)  NOT NULL DEFAULT 'active',  -- active | completed | archived
    total_cost_usd   NUMERIC(12,6) NOT NULL DEFAULT 0,   -- coarse rollup, updated on transitions
    archived         BOOLEAN      NOT NULL DEFAULT FALSE,
    archived_at      TIMESTAMPTZ,
    metadata         JSONB        NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tasks_user      ON tasks(user_id);
CREATE INDEX idx_tasks_project   ON tasks(project_id);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX idx_tasks_parent    ON tasks(parent_task_id);

-- Durable audit of approval decisions for dangerous operations. This is the ONE piece of
-- agent activity that is never sampled or offloaded — every request+resolution persists.
-- The mechanism is Shofer's native ask/respondToAsk + auto-approval engine; user-console
-- surfaces the ask in its UI and records the outcome here (a trusted control-plane action).
CREATE TABLE agent_approvals (
    approval_id      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id          UUID         NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    ask_id           VARCHAR(100) NOT NULL,   -- Shofer ask id (respondToAsk target)
    tool_name        VARCHAR(100) NOT NULL,
    arguments        JSONB,                   -- the operation being gated (redacted if large)
    approval_status  VARCHAR(20)  NOT NULL DEFAULT 'pending',
    decided_by       UUID         REFERENCES users(user_id),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at      TIMESTAMPTZ,
    CONSTRAINT check_approval_status CHECK (approval_status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX idx_agent_approvals_task ON agent_approvals(task_id);
```

There is no `l2_tool_calls` table: the full tool stream (L1 and L2) is the audit trail in
§4.15, not a control-plane table.

### 4.9 Resource Versioning & Snapshots (Phase 4)

```sql
CREATE TABLE resource_versions (
    version_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id    UUID         NOT NULL REFERENCES resources(resource_id) ON DELETE CASCADE,
    version_tag    VARCHAR(100) NOT NULL,
    snapshot_data  JSONB        NOT NULL DEFAULT '{}',
    created_by     UUID         REFERENCES users(user_id),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (resource_id, version_tag)
);

CREATE TABLE snapshots (
    snapshot_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID         NOT NULL REFERENCES workspaces(workspace_id),
    created_by    UUID         NOT NULL REFERENCES users(user_id),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    description   TEXT,
    automatic     BOOLEAN      NOT NULL DEFAULT FALSE,
    metadata      JSONB        NOT NULL DEFAULT '{}'
);

CREATE TABLE snapshot_resource_versions (
    snapshot_id  UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    version_id   UUID NOT NULL REFERENCES resource_versions(version_id) ON DELETE CASCADE,
    PRIMARY KEY (snapshot_id, version_id)
);
```

### 4.10 Notifications (Phase 4)

```sql
CREATE TABLE notifications (
    notification_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    title             VARCHAR(255) NOT NULL,
    message           TEXT         NOT NULL,
    notification_type VARCHAR(50)  NOT NULL DEFAULT 'info',  -- info | success | warning | error
    category          VARCHAR(100),
    is_read           BOOLEAN      NOT NULL DEFAULT FALSE,
    source            VARCHAR(100),
    source_id         VARCHAR(255),
    action_url        TEXT,
    metadata          JSONB        NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    read_at           TIMESTAMPTZ,
    CONSTRAINT check_notification_type CHECK (notification_type IN ('info', 'success', 'warning', 'error'))
);
```

### 4.11 Observability Dashboards (Phase 4)

```sql
CREATE TABLE observability_dashboards (
    dashboard_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    parent_id      UUID         REFERENCES observability_dashboards(dashboard_id) ON DELETE CASCADE,
    item_type      VARCHAR(20)  NOT NULL DEFAULT 'dashboard',  -- dashboard | folder
    name           VARCHAR(255) NOT NULL,
    description    TEXT,
    payload        JSONB,       -- full A2UI JSON
    source_query   TEXT,        -- original natural-language prompt
    display_order  INTEGER      NOT NULL DEFAULT 0,
    use_count      INTEGER      NOT NULL DEFAULT 0,
    last_used_at   TIMESTAMPTZ,
    icon           VARCHAR(50),
    color          VARCHAR(20),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### 4.12 Git Integration (Phase 5)

```sql
CREATE TABLE git_repositories (
    git_repo_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID         REFERENCES workspaces(workspace_id),
    repo_url             TEXT         NOT NULL,
    repo_type            VARCHAR(20)  NOT NULL DEFAULT 'internal',  -- internal | external
    default_branch       VARCHAR(255) NOT NULL DEFAULT 'main',
    local_path           TEXT,
    auth_method          VARCHAR(50)  NOT NULL DEFAULT 'none',  -- ssh_key | personal_access_token | oauth | none
    auth_credentials_ref VARCHAR(512),
    last_sync            TIMESTAMPTZ,
    created_by           UUID         NOT NULL REFERENCES users(user_id),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### 4.14 ClickHouse Tables (Phase 5 — Deferred)

Introduced only when time-series query volume justifies a dedicated column store. Until
then, resource metrics can be queried from Mimir (already deployed) and health status from
PostgreSQL.

```sql
-- ClickHouse: raw resource metrics (TTL: 90 days)
CREATE TABLE resource_metrics (
    resource_id    UUID,
    resource_type  LowCardinality(String),
    metric_name    LowCardinality(String),
    metric_value   Float64,
    metadata       String,
    collected_at   DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(collected_at)
ORDER BY (resource_id, metric_name, collected_at)
TTL collected_at + INTERVAL 90 DAY;

-- ClickHouse: hourly aggregation (TTL: 1 year)
CREATE TABLE resource_metrics_hourly (
    resource_id    UUID,
    resource_type  LowCardinality(String),
    metric_name    LowCardinality(String),
    hour           DateTime,
    min_value      Float64,
    max_value      Float64,
    avg_value      Float64,
    sample_count   UInt64
) ENGINE = MergeTree
ORDER BY (resource_id, metric_name, hour)
TTL hour + INTERVAL 1 YEAR;

-- ClickHouse: health check results (TTL: 90 days)
CREATE TABLE health_check_results (
    resource_id    UUID,
    resource_type  LowCardinality(String),
    status         LowCardinality(String),  -- healthy | unhealthy | starting | unknown
    message        String,
    latency_ms     Float32,
    checked_at     DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(checked_at)
ORDER BY (resource_id, checked_at)
TTL checked_at + INTERVAL 90 DAY;
```

### 4.15 Agent Audit Trail (Phase 4)

Organizations require complete visibility into what their users and AI agents do, so agent
activity is **fully captured, not sampled**. The recording model and trust argument are in
[§5.4](#54-agent-recording--audit-pipeline); this section is the schema.

The data has three natures, each in the store that fits its access pattern:

- **Structured audit rows → YugabyteDB.** The audit access pattern is point/range lookups
  ("everything user X did in session Y", "replay conversation Z", "produce this org's
  records", GDPR erasure) — OLTP-shaped, relational, must-not-lose. Yugabyte gives joins to
  the control-plane tables, ACID durability, and cheap point deletes; it scales writes and
  storage horizontally as volume grows. Rows stay small: the bulky payloads live in S3.
- **Large payloads → MinIO/S3.** Full message bodies and large tool results are
  content-addressed blobs; the Yugabyte row keeps only a `content_uri` + hash. Immutable
  and WORM-lockable for compliance; erasure/legal-hold is object lifecycle, not a columnar
  rewrite.
- **KPIs / analytics → ClickHouse.** High-cardinality product analytics (tokens/cost per
  org·user·model·project, tool counts, success rates) — dimensions that would blow up
  Prometheus cardinality. Dual-emitted from the recorder services, _derived_ not raw.

```sql
-- YugabyteDB (Postgres-compatible). One row per model turn, written by llm-router.
-- This is the agent's NARRATION: what it sent to / received from the model, which already
-- contains every tool_use/tool_result (native and MCP) folded into the message history.
CREATE TABLE agent_conversation_turns (
    turn_id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id            UUID         NOT NULL,   -- = tasks.task_id / Shofer task id
    parent_task_id     UUID,                    -- delegation hierarchy (L2→L1, L1→subtask)
    root_task_id       UUID,
    turn_index         INTEGER      NOT NULL,   -- monotonic per task
    model              VARCHAR(128),
    request_uri        TEXT,        -- S3 pointer to the request delta (new messages this turn)
    response_uri       TEXT,        -- S3 pointer to the completion
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    cost_usd           NUMERIC(12,6),
    latency_ms         INTEGER,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (task_id, turn_index)
);
CREATE INDEX idx_conv_turns_task ON agent_conversation_turns(task_id);
CREATE INDEX idx_conv_turns_root ON agent_conversation_turns(root_task_id);

-- YugabyteDB. Ground-truth tool invocations for MCP-brokered tools, written by mcp-server.
-- Independent of the agent's narration — lining these up turn-for-turn against the
-- conversation turns is what lets you DETECT a tampered agent (narration != ground truth).
CREATE TABLE agent_tool_calls (
    tool_call_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id          UUID         NOT NULL,     -- = tasks.task_id
    turn_index       INTEGER,                   -- correlates to agent_conversation_turns
    tool_name        VARCHAR(128) NOT NULL,
    arguments_uri    TEXT,        -- S3 pointer (args), inline small args in metadata
    result_uri       TEXT,        -- S3 pointer (result)
    success          BOOLEAN,
    error            TEXT,
    started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);
CREATE INDEX idx_tool_calls_task ON agent_tool_calls(task_id);
CREATE INDEX idx_tool_calls_name ON agent_tool_calls(tool_name);
```

```sql
-- ClickHouse. Derived KPI events, dual-emitted by the recorders (not the raw content).
-- Keyed to the same task hierarchy so it joins back to Yugabyte on task_id.
-- The single-writer-per-table carve-out (design principle 8): an append-only telemetry sink,
-- many producers, immutable source-tagged rows, zero mutation — so no shared-ownership hazard.
CREATE TABLE agent_activity_kpi (
    org_id           UUID,
    user_id          UUID,
    project_id       UUID,
    task_id          UUID,
    source           LowCardinality(String),   -- emitting service: llm-router | mcp-server | user-console
    agent            LowCardinality(String),   -- l1 | l2
    model            LowCardinality(String),
    tool_name        LowCardinality(String),
    prompt_tokens    UInt32,
    completion_tokens UInt32,
    cost_usd         Float64,
    latency_ms       UInt32,
    success          UInt8,
    event_at         DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (org_id, user_id, event_at);
```

Retention/TTL on all three stores is set per-organization by policy (the knob that replaces
sampling). `agent_approvals` (§4.8) is exempt — approvals are retained indefinitely for
compliance.

### 4.16 Agent Mesh (Phase 4)

Backs the agent mesh ([§5.5](#55-the-agent-mesh-registration-discovery-a2a)). Two tables: a
**runtime registry** of live agents (heartbeat-driven, distinct from the durable `tasks`
task record) and the **durable ledger** for async request/response (claim-id) messaging.

```sql
-- Runtime directory of live mesh participants. Written by the registrar; agents present a
-- provisioned workload identity, the registrar assigns tier/scope/trust_class (never
-- self-asserted). Liveness via heartbeat + TTL; a missed heartbeat expires the row.
CREATE TABLE agent_registry (
    agent_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tier           VARCHAR(16)  NOT NULL,           -- l1 | l2 | …
    scope_kind     VARCHAR(16)  NOT NULL,           -- org | project | namespace | workspace
    project_id     UUID         REFERENCES projects(project_id),
    workspace_id   UUID         REFERENCES workspaces(workspace_id),
    trust_class    VARCHAR(16)  NOT NULL DEFAULT 'untrusted',  -- trusted | untrusted | external
    capabilities   JSONB        NOT NULL DEFAULT '{}',   -- the "agent card": accepted/allowed message-types
    inbox_subject  VARCHAR(255) NOT NULL,           -- NATS subject for 1-1 delivery (agent.<id>.inbox)
    status         VARCHAR(16)  NOT NULL DEFAULT 'alive',    -- alive | draining | dead
    last_heartbeat TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    registered_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_registry_tier    ON agent_registry(tier);
CREATE INDEX idx_agent_registry_project ON agent_registry(project_id);
CREATE INDEX idx_agent_registry_status  ON agent_registry(status);

-- Durable ledger for the async req/resp (claim-id) paradigm. The source of truth for
-- outstanding requests; NATS is only transport. Survives sender/responder restart; audited.
-- Sole writer: mcp-server (the A2A gateway) — inserts on send_request, updates on respond.
CREATE TABLE agent_messages (
    request_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),   -- the claim id
    from_agent_id  UUID         NOT NULL REFERENCES agent_registry(agent_id),
    to_agent_id    UUID         REFERENCES agent_registry(agent_id),     -- NULL for topic publishes
    capability     VARCHAR(100) NOT NULL,     -- authz'd verb/message-type (tier×scope×capability)
    payload_uri    TEXT,                       -- S3 pointer for large payloads; small inline in metadata
    metadata       JSONB        NOT NULL DEFAULT '{}',
    status         VARCHAR(16)  NOT NULL DEFAULT 'pending',   -- pending | answered | expired | failed
    response_uri   TEXT,                       -- S3 pointer to the response when answered
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    responded_at   TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ
);
CREATE INDEX idx_agent_messages_to     ON agent_messages(to_agent_id, status);
CREATE INDEX idx_agent_messages_from   ON agent_messages(from_agent_id);
```

Sync req/resp and fire-and-forget notifications are **not** persisted here — the former is
ephemeral NATS request-reply, the latter rides JetStream. Only the claim-id paradigm needs the
durable ledger. The messages themselves are A2A MCP tool calls, so they are _also_ captured in
the audit trail (§4.15) as ordinary tool ground truth.

### 4.17 Pipeline Triggers (Phase 4)

The **only** new platform table the orchestration layer ([§5.6](#56-agentic-pipelines--orchestration))
needs: the trigger→pipeline binding rules. Pipeline **run/execution state lives in Temporal**, not
here (principle 8 — don't duplicate the orchestrator's store); GitLab owns tickets; `tasks` (§4.8)
cross-references a run's ticket + Temporal workflow id in its `metadata`.

```sql
-- Which events wake which pipeline, with what params, and whether it is hard-gated.
-- A governance surface: curated by the human / L2 (changes may themselves require approval).
CREATE TABLE pipeline_triggers (
    trigger_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID         REFERENCES projects(project_id),   -- NULL = org-wide
    name             VARCHAR(255) NOT NULL,
    event_pattern    VARCHAR(255) NOT NULL,   -- NATS subject/pattern, e.g. ops.alert.firing
    match            JSONB        NOT NULL DEFAULT '{}',   -- extra predicate (e.g. {"severity":"critical"})
    pipeline         VARCHAR(255) NOT NULL,   -- Temporal workflow type to start
    default_params   JSONB        NOT NULL DEFAULT '{}',
    task_queue       VARCHAR(100),            -- capability tag for the runner pool (§5.6)
    hard_gated       BOOLEAN      NOT NULL DEFAULT FALSE,  -- requires human approval to run
    enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by       UUID         REFERENCES users(user_id),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pipeline_triggers_project ON pipeline_triggers(project_id);
CREATE INDEX idx_pipeline_triggers_event   ON pipeline_triggers(event_pattern);
```

Owned (sole writer) by **user-console** (the human/L2 curate it via its API).

---

## 5. Services

### 5.1 user-console

**Language**: Go (new service, follows existing tech stack convention)

**Responsibilities:**

- Project management (CRUD, membership, k8s namespace lifecycle)
- User-facing REST API + UI (workspace CRUD, chat, notifications, observability)
- Workspace lifecycle coordination (delegates container ops to resource-manager)
- **Unified presentation layer (single pane of glass)** — user-console renders a _curated subset_
  of each backend system's state **in its own UI**, via that system's API: **Temporal** (pipelines
  — list/status/stages/pending-approvals), **Grafana** (metrics), **ArgoCD** (deploy/sync health),
  **GitLab** (tickets/MRs), **resource-manager** (resources). It does **not** re-implement their
  state — presentation + action-proxy over authoritative APIs (principle 10); each system stays the
  system of record and remains independently accessible for deep-dive/takeover.
- **Pipeline surface** — the Temporal slice of the above: lists all agentic pipelines + status
  (Temporal Visibility API, filtered by custom search attributes, joined with GitLab), maps event
  history → business-level stages, and manages them (pause/terminate/restart/resume) plus the
  **global kill switch** (§5.6). Operable **both manually** (UI) **and by L2** (the same ops are MCP
  tools) — the two paths converge on the same Temporal API and are both recorded.
- **Resource surface** — create + attach/detach project resources in the general sense (S3
  buckets, databases, filesystems, compute; §4.4) via resource-manager. Same duality: a human
  provisions/mounts by hand in the UI, or L2 does it via MCP tools — so the platform runs with
  agents off (principle 9). (Prod-deploy hard-gates surface here as gated **ArgoCD** syncs.)
- **L2 Agent control plane** — _drives_ the headless Shofer executor pool over `AgentApi`
  (start/message/cancel tasks, stream output, surface asks); it does **not** implement an
  agent loop (§5.3)
- Task lifecycle: writes `tasks` control-plane rows for both L1 and L2
- Approval workflow — relays Shofer `ask` approvals to the user and records the decision in
  `agent_approvals` via `respondToAsk`
- Control-plane audit: records session lifecycle + approvals (the raw conversation/tool
  trail is written by `llm-router`/`mcp-server`, not user-console — §5.4)

**API Surface:**

| Endpoint Group                           | Purpose                                           |
| ---------------------------------------- | ------------------------------------------------- |
| `POST/GET/PUT/DELETE /api/projects`      | Project CRUD (creates k8s namespace)              |
| `POST/DELETE /api/projects/{id}/members` | Project membership management                     |
| `GET /api/projects/{id}/members`         | List project members and roles                    |
| `POST/GET/DELETE /api/workspaces`        | Workspace CRUD                                    |
| `POST /api/workspaces/{id}/start`        | Start a stopped workspace                         |
| `POST /api/workspaces/{id}/stop`         | Stop a running workspace                          |
| `POST /api/workspaces/{id}/destroy`      | Permanently destroy a workspace                   |
| `GET/POST /api/chat/sessions`            | Chat session management                           |
| `POST /api/chat/sessions/{id}/messages`  | Send message to L2 agent                          |
| `GET/POST /api/resources/services`       | Service cluster management (Spark, Airflow, etc.) |
| `GET/POST /api/notifications`            | User notifications                                |
| `GET/POST /api/observability/dashboards` | Saved dashboards                                  |

**DB Access Pattern**: SQLC or sqlx (Go), accessing `workspaces`, `tasks`,
`agent_approvals`, `notifications`, `observability_dashboards`. It does **not** write the
audit trail tables (§4.15) — those are owned by `llm-router` and `mcp-server`.

**Key Design Decisions:**

- Workspace creation flow: (1) create filesystem via resource-manager, (2) insert
  `workspaces` row, (3) mount filesystem via resource-manager, (4) create compute
  (code-server + Shofer L1) via resource-manager.
- resource-manager is an **optional runtime dependency** — user-console starts in degraded
  mode if resource-manager is unavailable. Health checks and basic queries still work.
- **`mcp-server` / `tools-backend` run outside the workspace, org-global — not sidecars —
  by design, for security** (for now at least). The tool broker holds credentials and reaches
  infrastructure; it must stay on the _trusted_ side of the boundary, never co-located inside
  the user-tamperable workspace pod. Workspace pods run only code-server + Shofer L1 (+ the
  arkware-orchestrator companion). This is coherent because the broker serves _non-workspace-
  local_ tools (infra/platform/shared); Shofer's own _mutating native tools_
  (`write_file`/`apply_patch`/`execute_command`) stay in-process in the workspace.
- **Consequence for the native-tool audit gap (§5.4):** because the broker is deliberately
  off-workspace, routing those mutating native tools through `tools-backend` is _off the table
  for now_ — so their ground-truth capture falls to `llm-router` narration (+ optional
  infra-level fs/exec audit), not app-layer brokering.

### 5.2 resource-manager

**Language**: Go (new service)

**Responsibilities:**

- Infrastructure provisioning via Kubernetes API (Deployments, StatefulSets, PVCs,
  NetworkPolicies)
- S3 bucket lifecycle (MinIO / Vultr Object Storage)
- Filesystem management (CephFS PVCs, Vultr NFS)
- Resource state tracking and reconciliation
- Workspace-resource mounting (records in `workspace_resources`)
- Resource RBAC enforcement
- Connection info generation for mounted services

**API Surface:**

| Endpoint Group                      | Purpose                                  |
| ----------------------------------- | ---------------------------------------- |
| `POST/GET/DELETE /api/compute`      | Compute resource lifecycle               |
| `POST /api/compute/{id}/start`      | Start compute                            |
| `POST /api/compute/{id}/stop`       | Stop compute                             |
| `PUT /api/compute/{id}/limits`      | Update resource limits                   |
| `PUT /api/compute/{id}/filesystems` | Add/remove filesystem mounts             |
| `GET/POST/DELETE /api/buckets`      | S3 bucket management                     |
| `GET/POST/DELETE /api/filesystems`  | Filesystem management                    |
| `POST /api/resources/{id}/mount`    | Mount resource to workspace              |
| `DELETE /api/resources/{id}/mount`  | Unmount resource from workspace          |
| `GET /api/resources/{id}/metrics`   | Resource utilization metrics             |
| `GET /api/services`                 | List hierarchical services with children |

**DB Access Pattern**: SQLC or sqlx (Go), owning `resources` and all `resource_*` tables,
`workspace_resources`.

**Providers:**

| Provider                 | Manages                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `kube_compute`           | K8s Deployments/StatefulSets with replicas, sidecars, volume claims |
| `kube_cephfs_filesystem` | CephFS PVCs (RWX for shared, RBD for databases)                     |
| `s3_buckets`             | MinIO/S3 bucket lifecycle                                           |

**Key Design Decisions:**

- Uses Kubernetes Watch-based reconciliation for deleted resources (self-healing).
- Resource state updates are atomic (captures old state for event emission).
- Connection info is built per-service-type and stored in `workspace_resources` for
  tools-backend discovery.
- Hierarchical resources: a `service` (resource_type='service') is a root with child
  `compute` resources (resource_type='compute', parent_resource_id set). Used for
  multi-component services like Spark (master + workers + history server).

### 5.3 L2 Agent (FE + headless backend)

L2 is **two components**, and neither is a bespoke agent implementation:

- **The FE — `user-console`.** The end-user's front door to the service, and therefore the
  natural home for provisioning and approvals. It _drives_ the agent loop; it does not run it.
- **The backend — a dedicated headless-Shofer executor** (`shofer serve`, HTTP/SSE over
  `ShoferApiAgent`), org-global. `user-console` drives it over the `AgentApi` transport — the
  _same_ control plane Shofer Nodes uses ([`v3_architecture.md`](./v3_architecture.md) §12).
  The agent loop, tool schema system, unified permission/auto-approval engine, cancellation,
  cost/limits, model dispatch (via `llm-router`, the `shofer` provider), and SQLite execution
  state all come from `@shofer/core` unchanged. The platform writes a controller, not an agent.

`AgentApi` is the **intra-agent** control plane — an agent's FE ↔ its own BE. It is **not** an
agent-to-agent mechanism: L2↔L1 goes over the **agent mesh** (§5.5), never over `AgentApi`.

**What L2 is, precisely:**

- **A pure controller/tool-caller with no filesystem access.** L2 acts through MCP tools: infra
  ops (`create_workspace`, `scale_service`, `list_resources`, provision/attach resources, …) on
  the org-global `mcp-server`, **pipeline tools** (list/pause/terminate/restart/resume, §5.6),
  **GitLab tools** to create/assign/update tickets (how it delegates product work, §5.6), and
  **mesh tools** (§5.5) to observe/message other agents at runtime. Every one of these has a
  manual equivalent in user-console's UI (principle 9).
- **Read-only on the _work_ inside a Project; the exclusive provisioner of Project
  resources.** L2 delegates work to L1 and observes it, but never touches project files/code
  itself. Provisioning (which costs money) is L2-only and always approval-gated — the
  asymmetry follows from user-console being the end-user's front door.
- **Delegation to L1 goes through GitLab, not a direct spawn.** L2's primary way to get work
  done is to **create/update a GitLab ticket** (the north star, §5.6); a Temporal-pooled runner
  then claims it and runs an L1 agent. L2 does **not** directly drive an L1 over `AgentApi` (an
  intra-agent channel) — the mesh (§5.5) is only for runtime signalling/escalation, and the
  ticket is the durable, human-legible, take-over-able unit of work. Any spawned L1 task is a
  _new top-level task_ (never a hijack of the human's interactive task).
- **Locked-down mode.** No code workspace, checkpoints, code index, or diff views — gated off
  via the permission engine, leaving only the infra + mesh tool surface.
- **Approvals are Shofer-native.** Dangerous tools emit an `ask`; user-console surfaces it and
  replies with `respondToAsk`; the decision persists in `agent_approvals` (§4.8).

**Two scaling axes — don't conflate them (§5.5):** _vertical_ scaling of the L2 backend is the
existing `NodeRegistry` + `ExecutorPool` (root-task routing across headless-Shofer pods; L2 is
an easy target since its conversations hold no shared working-tree state). _Horizontal_
coordination with L1 and other agents is the mesh. An L2 backend can be a vertical pool **and**
a single horizontal mesh participant at once.

**Config replication to the pool — shipped.** The vertical pool's node-scoped settings — the
**auto-approval policy** (toggles, command allowlists, and the outside-workspace trusted-path
allowlist) plus behavioral/cost limits — are **controller-authoritative and replicated to every
headless pod** by the config-sync channel ([`config_sync.md`](./config_sync.md), implemented):
`user-console` sets policy once and it reaches each `shofer serve` pod on connect and on every
change with **zero node-side admin**, and is _version-gated_ so a pod becomes assignable only
after it has applied the current config. That is what lets the pods be stateless replicas the
control plane can provision, scale, and reconfigure freely — a per-tenant/per-agent policy
change on the controller propagates to the fleet without touching any pod. (This is the shipped
shared-workspace model; `mcpEnabled` is deliberately not replicated — see `config_sync.md` §3.)
For **L1** workspace agents, which _do_ touch files, the
[outside-workspace path allowlist](./outside-workspace-path-allowlist.md) (a config-sync
consumer) lets the platform pre-trust a project's mounted resource paths so the agent
auto-approves reads/writes under them instead of prompting per file — read/write separated,
with `write ⊇ read`.

### 5.4 Agent Recording & Audit Pipeline

The audit **system of record is not the agent's own event stream** — for L1 that stream
originates in a workspace the end user controls and could tamper with. Instead, audit is
derived from the org-global services on the request path, which the user only reaches
through defined APIs. Three trusted recorders, one store each nature (schema in §4.15):

| Recorder (trusted) | Captures                                                                                                                                            | Nature                    | → Store                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------- |
| **llm-router**     | complete transcript — thinking + every `tool_use`/`tool_result` (native _and_ MCP), because the agent folds them into the message history each turn | the agent's **narration** | Yugabyte rows + S3 payloads; KPIs → ClickHouse |
| **mcp-server**     | actual invocation + result for **MCP-brokered** tools                                                                                               | **ground truth**          | Yugabyte rows + S3 payloads; KPIs → ClickHouse |
| **user-console**   | session lifecycle + approval decisions                                                                                                              | control-plane state       | Yugabyte (`tasks`, `agent_approvals`)          |

Key properties:

- **Narration vs ground truth.** `llm-router` sees everything the agent _claims_ it did (a
  tampered agent could feed the model a doctored tool result); `mcp-server` sees what the
  brokered tool _actually_ did. Lining the two up turn-for-turn on `task_id` is how
  tampering is detected — divergence is the signal.
- **Storage split for volume.** Structured rows in Yugabyte stay small; bulky message
  bodies / large tool results go to MinIO/S3 content-addressed, referenced by URI. Per-turn
  **deltas** are stored, not full-history snapshots (each `llm-router` request re-sends the
  accumulated history — recording it whole would be O(n²)).
- **KPIs are dual-emitted, not ETL'd.** The recorders emit a lightweight aggregatable
  projection to ClickHouse directly (they already hold tokens/latency/tool/success),
  alongside the durable Yugabyte write. No Yugabyte→ClickHouse pipeline.
- **Operational metrics stay in Mimir/Tempo.** Pod latency, error rates, and the
  conversation span tree (already carrying `task_id`/`parent`/`root`) are
  low-cardinality ops telemetry — ClickHouse is only for high-cardinality _product_ KPIs.

**Two load-bearing preconditions (open items):**

1. **Egress lockdown (security invariant).** `llm-router` is only a complete choke point if
   the workspace _cannot_ reach an external LLM API directly. A workspace NetworkPolicy must
   block all outbound except the platform services; otherwise a tampered agent bypasses
   recording with no error. This must be part of the workspace namespace's NetworkPolicy
   plan, not an afterthought.
2. **The native mutating-tool gap.** Shofer's `write_file`/`apply_patch`/`execute_command`
   run in-process in the workspace pod and do not touch `mcp-server`, so ground-truth capture
   of file/exec mutations has a hole. The app-layer fix — routing them through
   `tools-backend` — is **ruled out for now**: `mcp-server`/`tools-backend` deliberately run
   _outside_ the workspace for security (§5.1), so a central broker reaching into workspace
   fs/exec is exactly what we're avoiding. That leaves two live options: **accept `llm-router`
   narration** for file/exec (reserving ground truth for the dangerous _infra_ tools, which
   are MCP → already ground-truthed) — the likely launch 80/20 — **and/or** add **infra-layer
   audit** (CephFS fs-audit, eBPF/Falco exec-audit) when a fully-tamper-proof record of
   workspace mutations is required.

### 5.5 The Agent Mesh (registration, discovery, A2A)

L2↔L1 is not a special pipe; it is one case of a general problem — **agents materialized at
different places in the infrastructure need to discover and talk to each other.** The mesh is
that fabric. It generalizes what were three ad-hoc channels (L2→L1 spawn, L1→L2 escalation,
cluster-event notifications) into **one substrate + three communication paradigms**.

#### Materialization sites

A workspace is not special — it is one **materialization site** for an agent, a point in the
space `(host adapter × tier × tool-set × lifecycle × trust class × scope)`. The same portable
`@shofer/core` runs at each site behind a different Category II host adapter
([`v3_architecture.md`](./v3_architecture.md)); the mesh is what lets those independently-owned
cores find and message one another.

| Site                                 | Host adapter             | Lifecycle                     | Trust class                      | Scope       |
| ------------------------------------ | ------------------------ | ----------------------------- | -------------------------------- | ----------- |
| Workspace (L1)                       | code-server + project fs | long-lived, interactive       | **untrusted** (human-tamperable) | project ns  |
| L2 backend                           | headless, no fs          | org-global service            | trusted                          | org         |
| Ephemeral job                        | headless, task-scoped    | spun up / torn down (k8s Job) | trusted                          | project/org |
| Future: on-prem / edge / other cloud | headless                 | varies                        | its own class                    | external    |

Adding a site costs nothing new, because the coordination model is not workspace-shaped.

#### The mesh sidecar — the `agent-mesh` plugin

The mesh sidecar is realized as a **general Shofer plugin, `agent-mesh`** ([`agent-mesh/DESIGN.md`](../plugins/agent-mesh/DESIGN.md); pure JS; §5.6) — the
**SaaS face of an otherwise-local Shofer** that makes any Shofer instance a mesh participant. It
adds **zero SaaS code to `@shofer/core`** — everything stays on the _config_ side of the line
(Shofer Router provider + a centralized `mcp-server` + this plugin), never the _code_ side, and it's
a standard Shofer feature (not arkware-specific). A non-Shofer agent would join by implementing an
equivalent adapter. (The runner role is a _separate_ plugin, `temporal-runner`, §5.6.)

The division of labor is by **who drives the operation** — _if the mesh depends on it, or it
is done to the agent, it is arkware-orchestrator; if the agent chooses to do it, it is an MCP
tool_:

- **Involuntary / out-of-band → arkware-orchestrator.** Registration, heartbeat/health,
  deregistration, and **inbound delivery** (bus → local `ShoferAPI` injection of a request,
  notification, or response-ready). These run deterministically at lifecycle events,
  independent of the model — registration-on-startup is not something an LLM should "decide"
  to call, and "a message arrived for you" cannot be modelled as a tool the agent invokes.
- **Voluntary / in-band → MCP tools** (below). Deliberate agent acts, gated + audited at the
  `mcp-server`.

This gives two properties for free: **reliability** (registration/heartbeat are lifecycle-
driven, immune to LLM nondeterminism), and **trust** (identity/tier is presented by the
platform sidecar and _blessed by the registrar_, bound to the pod's provisioned workload
identity — never self-asserted by a possibly-compromised agent).

#### Identity, registry, discovery (b)

Every participant is an **agent** — distinct from a task — held in a runtime **agent registry**
(§4.16), owned by a trusted, org-global **registrar**:

- `agent_id`, `tier` (l1|l2|…), `scope` (org/project/namespace/workspace), `capabilities` (an
  "agent card": what it accepts / can do), `trust_class`, and liveness (heartbeat + TTL).
- The registrar **decides** tier/scope/trust-class (not self-asserted), and issues the scoped
  mesh credentials.
- **Discovery** = query the registry, **authz-filtered by the caller** (an L1 sees L2 and its
  permitted peers, never other L1s).

Keep this runtime liveness registry separate from the durable task record (`tasks`),
linked by `agent_id`↔`task_id`. Align the agent-card shape with the emerging Agent2Agent (A2A)
standard so a non-Shofer face can join later.

#### Transport & the three paradigms (c)

**One bus — NATS** — carries all A2A traffic _and_ the cluster-event notifications; JetStream
backs the durable cases; Yugabyte is the durable ledger for outstanding async requests.

| Paradigm                      | Use                                                            | Transport                                    | Durable ledger                                                       |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| **sync req/resp**             | quick queries; caller blocks                                   | NATS request-reply                           | no (ephemeral; fail-fast on dead/busy via registry health + timeout) |
| **async req/resp (claim id)** | long ops — escalation, provisioning that spans a user approval | NATS delivers request + a later "ready" ping | **yes — `agent_messages` (§4.16)**                                   |
| **async notification**        | cluster events, fire-and-forget                                | NATS pub/sub (JetStream for must-deliver)    | JetStream retains; no correlation                                    |

The middle paradigm is the load-bearing one: the sender gets a `request_id` **immediately**,
keeps working, and retrieves the response later (poll, or receive a pushed "ready"
notification). Because it must survive the sender restarting and be queryable + auditable, the
**Yugabyte `agent_messages` ledger is the source of truth for outstanding requests; NATS is
only transport.** This subsumes the earlier "DB-outbox" for escalation.

#### Agent-facing surface & authorization

The voluntary surface is **MCP tools** (so `@shofer/core` stays generic and every A2A action is
gated + audited at the `mcp-server` for free, exactly like any tool call — §5.4):

- `discover_agents(filter)` · `send_message(to, …, {mode: sync})` · `send_request(to, …) →
request_id` · `get_response(request_id)` · `respond(request_id, …)` · `publish(topic, …)` ·
  `subscribe(topic)`.

**Authorization = tier × scope × capability** (with `trust_class` as a modifier), reusing the
unified permission engine (§3) rather than a parallel model — grants default-by-tier,
overridable per-agent/project. Capability is the fine-grained
verb/message-type layer (e.g. L1 holds `request:provision→L2` but not `command:spawn→any`), so
**L1→L1 is denied while L1→L2 escalation is allowed.** Enforcement is **primary at the
`mcp-server` gateway** (trusted + audited); NATS account-scoped credentials are available later
as defense-in-depth. An untrusted L1 never holds direct bus access — its only A2A path is the
gateway tool, and egress lockdown (§5.4) means it cannot reach NATS to target another L1.

#### What rides the mesh (and what doesn't)

The mesh is **runtime signalling**, not the work-handoff backbone — durable work assignment is
GitLab tickets + the Temporal runner pool (§5.6). On the mesh:

- **L1 escalates to L2** (e.g. "I need infra provisioned") = an async req/resp (claim id) —
  durable in `agent_messages`.
- **cluster events → L1** = a 1-N async notification, delivered by subscription.
- **live telemetry / token streams / status** = fire-and-forget pub/sub (feeds user-console's
  live view), deliberately kept out of Temporal's workflow history (§5.6).

When a mesh signal must actually start local work, arkware-orchestrator translates it to a
**local `ShoferAPI` call** — the sidecar is the adapter from the horizontal mesh down to the
vertical intra-agent plane; `AgentApi` never crosses between two agents.

### 5.6 Agentic Pipelines & Orchestration

The agent-automation layer (principles 9–10): a **source-agnostic, event-driven** pipeline system
that triggers and durably runs agent work, sitting **on top of** a platform that stays fully
operable by hand. Each system does one thing:

| Layer                     | Responsibility                                                                        | Tech                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Orchestration**         | when/sequence, durability, retries/timeouts, human-approval gates, capability routing | **Temporal**                                         |
| **Coordination (record)** | intent, assignment, handoff, the take-over-able trail                                 | **GitLab** (tickets/MRs/CI) + the **mesh** (runtime) |
| **Agent runtime**         | the loop, tools, reasoning, checkpoints                                               | **Shofer** (`@shofer/core`) — the _sole_ runtime     |
| **Model access**          | provider routing, cost/limits                                                         | **llm-router**                                       |
| **Tools**                 | file/exec/search/LSP + integrations                                                   | native (Shofer) + **MCP**                            |
| **Signalling & ingress**  | event normalization, telemetry, A2A                                                   | **NATS**                                             |
| **Human control plane**   | oversight, decisions, kill switch                                                     | **user-console**                                     |

#### Trigger / ingress plane (source-agnostic)

Pipelines bind to **events**, not to any one system — **GitLab is one source among many.** All
sources normalize onto **NATS**, and a stateless **event-ingress** adapter maps subjects to
pipeline starts:

- GitLab webhook → `sdlc.ticket.ready` / `sdlc.mr.opened` …
- Alertmanager webhook → `ops.alert.firing` …
- cron → `schedule.*`
- user-console + agents → publish directly

The **trigger→pipeline binding rules** (`pipeline_triggers`, [§4.17](#417-pipeline-triggers-phase-4))
say _which events wake which pipelines, with what params, and which are hard-gated_ — e.g.
"`ops.alert.firing` severity=critical → incident-response pipeline." This is a governance surface
the human/L2 curates. On a match, the adapter starts a Temporal workflow with an **idempotency key**
(a duplicate webhook can't double-run).

#### Execution plane (durable, no-SPOF)

**Temporal** runs each pipeline as a **deterministic workflow** (routing, retries, timeouts,
sequencing, and human-approval **gates via signals** — a workflow can block for hours/days on an
approval, then resume). Work is dispatched **pull-based**: workers long-poll **capability-tagged
task queues** (`runner:coding`, `runner:sre`, `gpu`, …). **There is no central dispatcher** —
runners self-select when they have capacity (natural load-balancing/backpressure), a dead runner
just stops pulling, and scaling = more runners join. **That pull model _is_ the horizontal-scale +
no-SPOF property**, and it's where GitLab's logical assignment (the auditable claim/assignee) meets
physical scheduling.

**The runner is the `temporal-runner` plugin** — a general Shofer plugin
([`temporal-runner/DESIGN.md`](../plugins/temporal-runner/DESIGN.md)) that hosts a Temporal worker via `ctx.registerService`
and, on pickup, drives the co-located **Shofer** through the scoped **`ctx.agent.spawn`** API
([`plugin_system.md` §14](./plugin_system.md#14-proposed-agent-control-api-for-workflow--runner-plugins)).
The **determinism rule** is strict: the agent/LLM loop is non-deterministic, so it runs **only inside
a Temporal _Activity_, never a Workflow**.

```ts
// Deterministic controller — routing, gates, sequencing. No LLM calls here.
async function devPipeline(ticket) {
	const result = await act({
		taskQueue: "runner:coding",
		startToCloseTimeout: "2h",
		heartbeatTimeout: "2m",
	}).runShoferTask({ prompt: ticket.spec })
	await condition(() => approved) // hard-gate: signal-driven pause/resume
	await act({ taskQueue: "glue" }).mergeAndDeploy(result)
}
// Activity in the temporal-runner plugin: non-determinism isolated; drives Shofer via ctx.agent (§14).
async function runShoferTask({ prompt }) {
	const h = await ctx.agent.spawn(prompt) // §14 handle
	h.onEvent(() => activity.heartbeat()) // telemetry is the agent-mesh plugin's job, not the runner's
	return await h.result() // resume-safe via checkpoints
}
```

#### Two plugins, one transport each (mesh vs runner)

The per-node capability ships as **two composable, general Shofer plugins** — not one — split by
transport, each exposing agent-facing tools:

- **`agent-mesh`** (pure JS, owns **NATS**): registration + inbound **notification delivery** into the
  agent (`ctx.agent.notify`) + opt-in telemetry; agent tools **`mesh_publish` / `mesh_subscribe`**
  (emit/subscribe to async events) plus **static config subscriptions**. Loadable on **any** node.
- **`temporal-runner`** (native `@temporalio/*`, owns **Temporal**): pull → `ctx.agent.spawn` →
  return; agent tools **`temporal_task_queue_status` / `list_workflows` / `describe_workflow`**
  (read-only introspection). Loaded only on runner nodes.

They share nothing and **coordinate through Shofer** (the runner spawns tasks; the mesh plugin
observes their events via `onEvent` and publishes telemetry). Splitting by transport keeps
`agent-mesh` pure-JS/portable and confines the native Temporal core to nodes that actually run
pipelines. (This refines the earlier "one plugin subsumes runner + mesh".)

#### How NATS and Temporal interlock (they never talk directly)

NATS is the **event/notification/telemetry** plane; Temporal is the **durable orchestration** plane.
They connect only at **two bridge points that each hold both a NATS connection and a Temporal
client** — Temporal itself is NATS-agnostic (a workflow is deterministic and can't do I/O; the way a
running workflow reacts to the outside is a **signal**):

| Pattern                                  | Direction                  | Handled by                                                                                             |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Trigger** — an event starts a pipeline | NATS → Temporal            | **ingress bridge** (NATS consumer + Temporal client → `workflow.start`)                                |
| **Execute** — a pipeline runs agent work | Temporal → runner          | `temporal-runner` plugin (Temporal **task queue** — no NATS)                                           |
| **Telemetry** — live agent output        | agent → NATS               | `agent-mesh` plugin (`onEvent` → publish; _not_ Temporal history)                                      |
| **Human-gate / notify**                  | Temporal ↔ human via NATS | workflow waits on a **signal**; notification rides NATS; approval → Temporal **signal** (user-console) |

So "an event triggers a pipeline" is **NATS → ingress bridge → `client.workflow.start()`** — never
Temporal subscribing to NATS. The two bridges — the **ingress adapter** (trigger plane, above) and
**user-console** (which holds a Temporal client + a NATS subscription) — are the _only_ components
that speak both; the two per-node plugins each speak exactly one transport.

#### The agent runtime is Shofer (LangChain considered, rejected)

Shofer is the **single agent runtime**; nothing else occupies that slot. LangChain/LangGraph was
evaluated and **rejected**: it overlaps Shofer's exact role (loop + tools + model dispatch + state)
and would rebuild — and bypass — what Shofer already gives us and this design depends on: the
**code-specialized tool suite** (apply-patch/diff, ripgrep, LSP tools, process-managed exec), the
**permission engine** (the hard-gates), the **§5.4 audit + cost accounting**, and **checkpoints +
worktree isolation** (which is precisely what makes Temporal retries _resume-safe_). Decisively,
Shofer is **the same engine the human drives interactively in VS Code (L1)** — so using it
everywhere is what makes **takeover uniform** (a human can take over a pipeline's workspace in
their IDE and continue identically). Steps needing only a one-shot completion (classify/summarize)
call **llm-router directly** (no agent framework); Python glue runs in **polyglot Temporal workers**.

#### Temporal vs Shofer/Slang workflows — outer vs inner loop (complementary, not redundant)

Shofer has its own workflow system (**Slang**, `.slang` in `@shofer/core`). It does **not** overlap
Temporal — they sit at different altitudes and **nest**:

- **Temporal** orchestrates **between** agent runs, across the fleet: durable, distributed,
  long-running (spans human approvals/deploys), retried, cross-service. It's the pipeline's
  "when/where/gate/retry."
- **Slang** orchestrates **within** a single agent run, in-process: a repeatable/introspectable
  procedure that structures one agent's multi-step / sub-agent work. Ephemeral to the task.

They compose one-directionally: `Temporal pipeline → Activity → Shofer → (optionally) Slang →
sub-agents`. Slang can't wrap Temporal (it's in-process; it can't survive a runner death or wait a
week for approval). This mirrors v3's own split — Slang lives on the **in-process/vertical** side
(like `new_task`), Temporal + the mesh on the **distributed/horizontal** side. And it reinforces the
determinism rule: a Slang workflow _is_ non-deterministic Shofer execution, so it runs **inside an
Activity, never as a Temporal Workflow**. Rule of thumb: durable/cross-run/gated → Temporal; a
structured procedure inside one agent's step → Slang (most steps need neither — a plain agent run
suffices).

#### Resume-safety = the "leave the wheel safe" contract

Agent activities have **side effects** (files written, branch pushed, MR opened, LLM spend), so
Temporal's "retry on a healthy runner" is correct only if the activity is **resume-safe, not
blindly re-run**:

- **Shofer checkpoints + per-task worktree** — a retry reattaches and continues from the last
  checkpoint, never restarts from zero.
- **Idempotency keys** on outward actions (MR keyed to the ticket, provisioning keyed to a request
  id) so a retry reconciles instead of duplicating.
- **Activity heartbeat** so a long agent run isn't mistaken for a dead worker.

This is the same contract a **human takeover** or the **global kill switch** relies on: an agent
always leaves its work in a resumable state — status + next step in the ticket, WIP branch pushed,
no half-applied irreversible op.

#### Build and Operate pipelines

Same engine, same pool, same hard-gates — two trigger classes (this is the "build _and run_ the
product" north star, §1):

- **Build** (SDLC-triggered): `sdlc.ticket.ready` → a coding L1 agent → branch → MR → CI → ticket closed.
- **Operate** (ops-triggered): `ops.alert.firing` → an SRE agent investigates via Grafana/logs,
  diagnoses, hard-gated remediation if prod, opens + resolves the incident ticket.

Either way the pipeline **externalizes into GitLab** for the record — so **trigger ≠ coordination
store: NATS carries the trigger, GitLab carries the record**, even for non-GitLab-triggered runs.

#### Lifecycle, manual operation & the kill switch

- **user-console lists every running pipeline** (querying Temporal, joined with GitLab assignment)
  and exposes **pause / terminate / restart / resume** on in-flight runs. These same lifecycle ops
  are **also MCP tools**, so **L2 can manage pipelines** just as the human does — manual (UI) and
  agent (MCP) paths converge on the same Temporal API, both recorded.
- **Manual overrides:** a human takes over a **ticket** (the agent yields — never fights for the
  wheel), or tells the agent directly; workspaces/resources/provisioning are operable **by hand**
  (L2 is _one_ path, not the only one), so the system runs with agents off.
- **Global agent switch** halts and disables all agent workflows → pure manual operation, agents
  leaving the wheel safe on the way down (principle 9).
- **Hard-gates = the reserved-rights / delegation-of-authority set** (provisioning, prod deploys;
  grows over time): each is human-approved (a Temporal signal), recorded, and has a manual equivalent.

**State ownership** (principle 8): run/execution state lives in **Temporal**; intent/coordination
in **GitLab**; `tasks`/audit in **Yugabyte**; only the binding rules are a new platform table (§4.17).
A `task` cross-references its ticket + Temporal workflow id (in `metadata`) so the three views align.

---

## 6. Phased Rollout Plan

Each phase delivers a self-contained increment of functionality. Phases are ordered by
dependency: each builds on the tables and services introduced in prior phases.

### Phase 0: Identity & Access Management

**Goal**: Establish multi-user foundation.

**Tables**: `organizations`, `users`, `groups`, `group_members`, `roles`, `privileges`,
`role_privileges`, `user_roles`, `group_roles`.

**Infrastructure**: Deploy Keycloak for OIDC authentication. Configure JWT validation in
all services. Configure the **kube-apiserver for OIDC** against the Keycloak realm (§2.2).

**Deliverables:**

- Database init script creating the identity schema.
- Keycloak deployment with realm, client, and default "Public" organization.
- A seed user belonging to the Public organization.
- JWT middleware for Go services (shared library).
- kube-apiserver OIDC config (issuer = the org's Keycloak realm, username claim =
  `keycloak_id`); `project-readonly` / `project-admin` ClusterRoles (§2.2).

**Exit criteria**: A user can authenticate via Keycloak and receive a JWT that identifies
their `user_id` and `organization_id`, and an OIDC token the kube-apiserver accepts (with no
namespace access yet — RBAC bindings come with projects in Phase 1).

---

### Phase 1: Projects & Workspace Lifecycle

**\*Goal**: Users can create projects, invite collaborators, and create/start/stop/destroy code-server workspaces within those projects.

**\*Tables**: `projects`, `project_members`, `workspaces`.

**\*Services**: user-console (initial version — project + workspace CRUD).

**Deliverables:**

- Project CRUD API: create, list, update, delete.
- Project membership management: invite users, assign roles (`owner`, `readwrite`,
  `readonly`), remove members.
- Workspace CRUD API (scoped to a project).
- Workspace state machine implementation.
- Direct k8s Deployment creation for code-server pods (no resource-manager yet —
  user-console provisions pods directly via k8s client). Pods run code-server + Shofer L1
  only; the MCP tool surface is served by the org-global `mcp-server` (§5.1), not a sidecar.
- Namespace creation (`ns-<namespaceId>-<slug>`) with owner/project-name annotations + id
  labels (§4.2).
- CephFS PVC creation for workspace persistent storage.
- **k8s RBAC reconciliation**: user-console projects `project_members` into per-namespace
  `project-readonly` RoleBindings keyed by `keycloak_id` (§2.2) — so members get
  namespace-scoped k8s read; add/remove a member ⇒ add/remove the RoleBinding.
- Access control: only project members can see/interact with project workspaces; role
  (`owner`/`readwrite`/`readonly`) is enforced at the app layer for mutation (k8s access is
  read-only for all members, §2.2).

**Exit criteria**: A user can create a project, invite another user with `readwrite`
role, and both can create workspaces within the project. A `readonly` member can view but
not create workspaces. The workspace state transitions correctly through the lifecycle.

**Note**: In this phase, user-console handles k8s operations directly. Phase 2 extracts
this into resource-manager.

---

### Phase 2: Resource Abstraction Layer

**Goal**: Introduce resource-manager as the infrastructure provisioning service. Refactor
user-console to delegate all container/filesystem operations.

**Tables**: `resources`, `resource_container`, `resource_compute`,
`resource_filesystem`, `resource_s3`, `resource_sqldb`, `workspace_resources`.

**Services**: resource-manager (initial version).

**Deliverables:**

- resource-manager service with compute, filesystem, S3 bucket APIs.
- Kubernetes provider (Deployments, StatefulSets, PVCs; platform-managed NetworkPolicies for
  project isolation + egress lockdown — not a tenant `network` resource).
- MinIO provider for S3 buckets.
- CephFS filesystem provider.
- user-console refactored to call resource-manager via HTTP for all infrastructure ops.
- `workspace_resources` mounting with connection_info generation.
- Resource state reconciliation via Kubernetes Watch.

**Exit criteria**: Workspaces are created via user-console → resource-manager flow.
Filesystems and S3 buckets can be created and mounted to workspaces.

---

### Phase 3: Project Quotas

**Goal**: Per-project resource quota enforcement, aligned with k3s. (Access control is already
project/namespace-level from Phases 1–2; a generic per-resource privilege layer is **deferred**,
§4.6.)

**Tables**: `resource_limits_project`.

**Deliverables:**

- Per-project quota reconciled into a k8s **ResourceQuota** on the project's namespace (CPU,
  memory, storage, PVC/pod counts), with an optional `LimitRange` for per-pod defaults.
- Project-total set from the org's plan at namespace creation; the **project owner distributes**
  capacity internally across workspaces (via `workspaces.max_cpu_cores`/`max_memory_mb`, §4.7).
- Provider-native auth remains the access mechanism for non-k8s resources (§4.6).

**Exit criteria**: A project cannot exceed its namespace quota; the owner can re-allocate the
project's capacity across its workspaces, and creation is rejected (by k8s) when the quota is
exceeded.

---

### Phase 4: Chat, Agent, Audit & Notifications

**Goal**: L2 Agent orchestration (headless Shofer), full agent audit, chat persistence, and
user notifications.

**Tables**: `tasks`, `agent_approvals`, `agent_conversation_turns`,
`agent_tool_calls`, `agent_activity_kpi` (ClickHouse), `agent_registry`, `agent_messages`,
`pipeline_triggers`, `notifications`, `observability_dashboards`, `resource_versions`,
`snapshots`, `snapshot_resource_versions`.

**Infrastructure**: Deploy ClickHouse (agent KPIs), **NATS** (mesh + event bus), **Temporal**
(pipeline orchestration), self-hosted **GitLab** (coordination system of record), **event-ingress**
adapters (GitLab/Alertmanager webhooks, cron → NATS → Temporal). Headless Shofer L2 backend
(`shofer serve`). Workspace-namespace egress lockdown (NetworkPolicy).

**Services**: user-console (the L2 FE/controller + pipeline list/lifecycle + kill switch);
**agent registrar**; **arkware-orchestrator** (mesh sidecar **+ Temporal worker**, §5.5–§5.6);
event-ingress; recorder + A2A-gateway responsibilities added to llm-router + mcp-server.

**Deliverables:**

- Headless Shofer L2 backend deployed; user-console drives it over `AgentApi` (§5.3).
- Infra tools exposed as **MCP tools** on the org-global mcp-server (`create_workspace`,
  `destroy_workspace`, `list_services`, `scale_service`, …).
- Chat + approval control plane in user-console (`tasks`, `agent_approvals` via
  Shofer `ask`/`respondToAsk`) — no bespoke agent loop or approval state machine.
- **Agent mesh** (§5.5): `arkware-orchestrator` sidecar (registration/heartbeat/inbound
  delivery), the registrar, NATS transport, the A2A MCP tools + tier×scope×capability authz
  at the mcp-server gateway. Three paradigms: sync req/resp, async req/resp (claim id,
  `agent_messages`), async notifications. Runtime signalling/escalation only — **never `AgentApi`**.
- **Agentic pipelines** (§5.6): source-agnostic ingress (NATS-normalized GitLab/Alertmanager/cron
  → `pipeline_triggers` rules → Temporal), Temporal durable workflows with human-approval gates,
  the pull-based capability-tagged runner pool (arkware-orchestrator = Temporal worker driving
  Shofer in Activities), resume-safety (checkpoints + idempotency + heartbeat). **Shofer is the
  sole agent runtime — LangChain considered and rejected.** Build + Operate pipeline classes.
- **Governance & manual operation** (§5.6): GitLab as coordination system of record (L2 creates
  tickets from user input; runners claim them); pipeline list + pause/terminate/restart/resume in
  user-console; the **global agent kill switch**; hard-gates (provisioning, prod deploys) each with
  a manual equivalent.
- **Audit pipeline** (§5.4): llm-router records conversation narration; mcp-server records
  MCP + A2A tool ground truth; large payloads → MinIO/S3; KPIs dual-emitted → ClickHouse.
- Egress lockdown so llm-router is a complete choke point (and L1 cannot reach NATS directly).
- Notification system (persisted notifications from events; delivered to L1 by subscription).
- Observability dashboard persistence (A2UI JSON, folder hierarchy).
- Resource versioning and workspace snapshots.

**Open decisions**: native mutating-tool ground-truth capture (accept-narration vs
infra-audit — app-layer brokering ruled out since the broker runs off-workspace, §5.1/§5.4);
confirm egress lockdown in the NetworkPolicy plan; sync-over-bus liveness semantics (reject vs
queue) and whether authz needs per-capability grants beyond
tier×scope from day one (§5.5).

**Exit criteria**: A user converses with L2, which (with approval) provisions and **files a
GitLab ticket**; a pooled runner **pulls** it, prepares a workspace, runs an L1 agent that opens
an MR, and the run is visible + pausable/terminable in user-console; an Alertmanager alert
triggers an **operate** pipeline through the same engine; an L1 escalation for new infra is gated
by user approval; the **global kill switch** returns the system to full manual operation; and
every turn + tool/A2A call is reconstructable from the audit trail without trusting the workspace.

---

### Phase 5: Metrics, Health & Git Integration

**Goal**: Time-series metrics, health monitoring, and Git repository tracking.

**Tables**: `git_repositories`. ClickHouse tables (if justified by volume):
`resource_metrics`, `resource_metrics_hourly`, `health_check_results`,
`health_status_daily`.

**Infrastructure**: Deploy ClickHouse (only if Mimir is insufficient for resource-level
time-series queries).

**Deliverables:**

- Resource metrics collection (CPU, memory, block I/O, network) — initially via Mimir
  push, optionally ClickHouse if query patterns demand it.
- Health check results storage and querying.
- Git repository tracking (internal via GitLab, external via GitHub/etc.).
- MCP server Git tools integration.

**Exit criteria**: Resource utilization is visible in the user-console dashboard. Git
repos can be associated with workspaces.

---

## 7. Infrastructure Dependencies

Summary of what infrastructure each phase requires beyond what is already deployed:

Everything below is **per organization cluster** (§2.1).

| Phase | New Infrastructure                                                                                                                                                                    | New Services                                                                                                                                                                                                                                        | New Tables                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Keycloak                                                                                                                                                                              | —                                                                                                                                                                                                                                                   | 8 identity tables                                                                                                                                                                                |
| 1     | —                                                                                                                                                                                     | user-console (Go)                                                                                                                                                                                                                                   | `projects`, `project_members`, `workspaces`                                                                                                                                                      |
| 2     | —                                                                                                                                                                                     | resource-manager (Go)                                                                                                                                                                                                                               | `resources` + 5 extension tables + `workspace_resources`                                                                                                                                         |
| 3     | —                                                                                                                                                                                     | —                                                                                                                                                                                                                                                   | `resource_limits_project` (→ k8s ResourceQuota); per-resource privileges deferred (§4.6)                                                                                                         |
| 4     | ClickHouse; **NATS** (mesh + event bus); **Temporal** (orchestration); self-hosted **GitLab**; **event-ingress** adapters; headless Shofer L2 backend; workspace egress NetworkPolicy | L2 = user-console FE + headless Shofer backend (`@shofer/core`, deployed not written); **agent registrar**; **arkware-orchestrator** (mesh sidecar + Temporal worker); event-ingress; recorder + A2A-gateway roles added to llm-router + mcp-server | `tasks`, `agent_approvals`, `agent_conversation_turns`, `agent_tool_calls`, `agent_activity_kpi` (CH), `agent_registry`, `agent_messages`, `pipeline_triggers`, + notification/versioning tables |
| 4+    | YugabyteDB (replaces PostgreSQL when volume warrants; same schema)                                                                                                                    | —                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                |
| 5     | (ClickHouse resource-metric tables — conditional)                                                                                                                                     | —                                                                                                                                                                                                                                                   | `git_repositories` + 4 ClickHouse tables                                                                                                                                                         |

### Database Init Strategy

Schema migrations are managed via SQL files versioned in `infra/kapitan/templates/setup/`.
Each phase has a numbered init script:

```
infra/kapitan/templates/setup/
├── 10-init-postgres.sh.j2        (existing — PostgreSQL bootstrap)
├── 20-init-identity.sh.j2        (Phase 0 — identity schema)
├── 21-init-projects.sh.j2        (Phase 1 — projects + project_members)
├── 21a-init-workspaces.sh.j2     (Phase 1 — workspaces table)
├── 22-init-resources.sh.j2       (Phase 2 — resources + extensions + mounts)
├── 23-init-limits.sh.j2          (Phase 3 — resource_limits_project)
├── 24-init-chat-agent.sh.j2      (Phase 4 — tasks + agent_approvals + audit trail)
├── 24a-init-agent-mesh.sh.j2     (Phase 4 — agent_registry + agent_messages)
├── 24b-init-pipelines.sh.j2      (Phase 4 — pipeline_triggers)
├── 25-init-versioning.sh.j2      (Phase 4 — versions + snapshots)
├── 26-init-git.sh.j2             (Phase 5 — git repositories)
└── 30-init-clickhouse.sh.j2      (Phase 5 — ClickHouse tables, conditional)
```

Each script is idempotent (`CREATE TABLE IF NOT EXISTS`) and can be re-run safely.

### Service Build & Deploy

New Go services follow the existing pattern:

```
user-console/
├── BUILD.bazel
├── Dockerfile
├── go.mod
├── cmd/server/main.go
├── internal/
│   ├── api/           # HTTP handlers
│   ├── project/       # Project + membership logic (k8s namespace management)
│   ├── workspace/     # Workspace service logic
│   ├── chat/          # Chat + L2 FE (drives the L2 headless backend over AgentApi)
│   ├── db/            # Database layer (SQLC)
│   └── observability/ # Metrics + tracing
└── README.md

resource-manager/
├── BUILD.bazel
├── Dockerfile
├── go.mod
├── cmd/server/main.go
├── internal/
│   ├── api/           # HTTP handlers
│   ├── db/            # Database layer (SQLC)
│   ├── providers/     # k8s, minio, cephfs providers
│   └── observability/ # Metrics + tracing
└── README.md

agent-registrar/          # mesh control plane (§5.5)
├── BUILD.bazel
├── Dockerfile
├── go.mod
├── cmd/server/main.go
├── internal/
│   ├── api/           # register / heartbeat / discover
│   ├── registry/      # agent_registry ownership, TTL expiry, tier/scope/trust-class
│   ├── creds/         # scoped-credential issuance
│   ├── db/            # Database layer (SQLC)
│   └── observability/ # Metrics + tracing
└── README.md
```

The **L2 backend** is not a new codebase — it is the shipped `@shofer/core` run headless
(`shofer serve`), deployed with an L2 provider/mode/tool config. **arkware-orchestrator** is a
TypeScript **companion** living at `extensions/arkware-orchestrator` (not a Go service): it
loads into each L1 workspace Shofer and the L2 backend via Shofer's plugin API + `ShoferAPI`,
and holds all L1↔L2 / mesh glue so nothing SaaS-specific leaks into `@shofer/core` (§5.5).

Kapitan templates for deployment:

```
infra/kapitan/templates/manifests/
├── 25-resource-manager.yaml.j2   (Phase 2)
├── 26-user-console.yaml.j2       (Phase 1, expanded in Phase 4)
├── 27-l2-agent.yaml.j2           (Phase 4 — headless Shofer L2 backend + workspace egress NetworkPolicy)
├── 28-agent-registrar.yaml.j2    (Phase 4 — mesh registrar)
├── 29-nats.yaml.j2               (Phase 4 — NATS mesh + event bus)
├── 30-temporal.yaml.j2           (Phase 4 — Temporal orchestration server)
├── 31-event-ingress.yaml.j2      (Phase 4 — GitLab/Alertmanager/cron → NATS → Temporal adapters)
└── 32-gitlab.yaml.j2             (Phase 4 — self-hosted GitLab, coordination system of record)
```

Configuration in `infra/kapitan/inventory/classes/common.yml`:

```yaml
# user-console configuration
user_console:
    port: 8000
    resource_manager_url: "http://resource-manager:8006"
    llm_router_url: "http://llm-router:3000"
    mcp_server_url: "http://mcp-server:3001"
    l2_agent_url: "http://l2-agent:5111" # headless Shofer, driven over AgentApi
    code_server_image: "local/code-server:latest" # workspace (L1) image; mcp-server/tools-backend are org-global, not sidecars
    workspace_default_cpu: 2
    workspace_default_memory_gb: 2
    nodeport: 30091

# L2 agent backend (headless Shofer executor pool; L2 FE lives in user-console)
l2_agent:
    port: 5111
    provider: "shofer" # routes model calls through llm-router
    base_url: "http://llm-router:3000/v1"
    replicas: 1 # vertical scale-out via NodeRegistry/ExecutorPool (later)
    nodeport: 30093

# Agent mesh (§5.5)
agent_registrar:
    port: 5120 # registration, health, tier/scope/trust-class, discovery
nats:
    url: "nats://nats:4222" # single bus: A2A + cluster-event notifications
    jetstream: true # durable delivery for must-deliver notifications
arkware_orchestrator:
    # per-agent companion (loaded into each L1 workspace Shofer and the L2 backend):
    # mesh sidecar + Temporal worker (§5.5–§5.6)
    heartbeat_interval_s: 15
    a2a_gateway_url: "http://mcp-server:3001" # voluntary A2A tools are gated + audited here
    temporal_task_queues: ["runner:coding"] # capability tags this node pulls (pull-based pool)

# Agentic pipeline orchestration (§5.6)
temporal:
    host: "temporal:7233"
    namespace: "arkware"
    # workflows = deterministic controllers; Shofer runs only inside Activities (never Workflows)
event_ingress:
    # stateless adapters: GitLab/Alertmanager webhooks + cron → NATS → start Temporal workflows
    sources: ["gitlab", "alertmanager", "cron"]
    nats_subject_prefix: "ingress"
gitlab:
    url: "http://gitlab" # coordination system of record (tickets/MRs/CI); agents act as bot users

# resource-manager configuration
resource_manager:
    port: 8006
    storage_provider: "cephfs" # cephfs | vultr_nfs | local
    nodeport: 30092
```
