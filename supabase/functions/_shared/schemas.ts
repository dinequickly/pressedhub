// Zod schemas for every edge-function request body. Keeps types and runtime
// validation in lock-step.

import { z } from "npm:zod@3.23.8";

// -- Workflows -----------------------------------------------------------

export const ConnectorIdSchema = z.string().min(1);

export const FilterSchema = z.object({
  field: z.string(),
  op: z.enum([
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "gt",
    "lt",
    "is_empty",
    "is_not_empty",
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const OutcomeSchema = z.object({
  description: z.string(),
  rubric_md: z.string(),
  max_iterations: z.number().int().min(1).max(20).optional(),
});

const NodeBase = { id: z.string().min(1) };

export const TriggerNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("trigger"),
  connector: ConnectorIdSchema,
  operation: z.string(),
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  filters: z.array(FilterSchema).optional(),
});

export const ActionNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("action"),
  connector: ConnectorIdSchema,
  operation: z.string(),
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  filters: z.array(FilterSchema).optional(),
  skills: z.array(z.string()).optional(),
});

export const ConditionNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("condition"),
  expression: z.string(),
  description: z.string().optional(),
});

export const AgentNodeSchema = z.object({
  ...NodeBase,
  type: z.literal("agent"),
  role: z.string(),
  tools: z.array(z.string()).default([]),
  instructions: z.string(),
  skills: z.array(z.string()).optional(),
  outcome: OutcomeSchema.optional(),
  memory_store_id: z.string().uuid().optional(),
});

export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  TriggerNodeSchema,
  ActionNodeSchema,
  ConditionNodeSchema,
  AgentNodeSchema,
]);

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});

export const WorkflowSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.enum(["deterministic", "react", "multi-agent"]),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  memory_store_id: z.string().uuid().nullable().optional(),
});

export const WorkflowCreateSchema = WorkflowSchema.omit({ id: true });
export const WorkflowUpdateSchema = WorkflowSchema.omit({ id: true }).partial();

// -- Agents (local) ------------------------------------------------------

export const AgentCreateSchema = z.object({
  name: z.string().min(1),
  role: z.string().default(""),
  emoji: z.string().default("🤖"),
  accent: z.string().default("violet"),
  model: z.string().default("claude-opus-4-7"),
  system_prompt: z.string().default(""),
  instructions: z.string().default(""),
  tools: z.array(z.unknown()).default([]),
  skills: z.array(z.unknown()).default([]),
  mcp_servers: z.array(z.unknown()).default([]),
  outcome: OutcomeSchema.optional(),
  brain: z.array(z.unknown()).default([]),
});

export const AgentUpdateSchema = AgentCreateSchema.partial();

// -- Environments --------------------------------------------------------

export const EnvironmentCreateSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.unknown()).default({
    type: "cloud",
    networking: { type: "unrestricted" },
  }),
});

// -- Sessions ------------------------------------------------------------

export const SessionStartSchema = z.object({
  workflow_id: z.string().uuid().optional(),
  agent_id: z.string().uuid(),
  environment_id: z.string().uuid(),
  vault_connection_ids: z.array(z.string().uuid()).optional(),
  title: z.string().optional(),
  initial_message: z.string().optional(),
  outcome: OutcomeSchema.optional(),
  trigger_payload: z.record(z.unknown()).optional(),
});

export const SessionSendEventSchema = z.object({
  events: z.array(z.union([
    z.object({
      type: z.literal("user.message"),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
    z.object({
      type: z.literal("user.interrupt"),
      session_thread_id: z.string().optional(),
    }),
    z.object({
      type: z.literal("user.tool_confirmation"),
      tool_use_id: z.string(),
      result: z.enum(["allow", "deny"]),
      deny_message: z.string().optional(),
    }),
    z.object({
      type: z.literal("user.custom_tool_result"),
      custom_tool_use_id: z.string(),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
  ])),
});

// -- Skills --------------------------------------------------------------

export const SkillCreateSchema = z.object({
  type: z.enum(["anthropic", "custom"]).default("custom"),
  name: z.string().min(1),
  description: z.string().default(""),
  content_md: z.string().default(""),
  pinned: z.boolean().default(false),
  // For type=anthropic, this is the short skill id (eg "xlsx").
  // For type=custom, this is auto-set after Anthropic create.
  anthropic_skill_id: z.string().optional(),
});

export const SkillUpdateSchema = SkillCreateSchema.partial();

// -- Vault connections ---------------------------------------------------

export const VaultConnectionCreateSchema = z.object({
  connector_id: z.string(),
  account_label: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  mcp_server_url: z.string().url().optional(),
  // The auth payload to forward to Anthropic vaults/credentials.create. The
  // schema mirrors Anthropic's, leaving exact shape validation to Anthropic.
  auth: z.record(z.unknown()).optional(),
});

// -- MCP servers ---------------------------------------------------------

export const McpServerCreateSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  description: z.string().default(""),
  metadata: z.record(z.unknown()).default({}),
});

export const McpServerUpdateSchema = McpServerCreateSchema.partial();

// -- Memory --------------------------------------------------------------

export const MemoryStoreCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  scope: z.enum(["workflow", "user", "shared"]),
  workflow_id: z.string().uuid().optional(),
});

export const MemoryStoreUpdateSchema = MemoryStoreCreateSchema.partial();

export const MemoryDocUpsertSchema = z.object({
  store_id: z.string().uuid(),
  path: z.string().min(1),
  content: z.string(),
});

export const MemoryRowUpsertSchema = z.object({
  store_id: z.string().uuid(),
  table_name: z.string().min(1),
  row: z.record(z.unknown()),
  row_id: z.string().uuid().optional(),
});

export const MemoryQuerySchema = z.object({
  store_id: z.string().uuid(),
  // For document fetch: pass `path`. For table query: pass `table_name` and an
  // optional `where` jsonb filter.
  path: z.string().optional(),
  table_name: z.string().optional(),
  where: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

// -- Dreams --------------------------------------------------------------

export const DreamDecideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().optional(),
});

// -- KB ------------------------------------------------------------------

export const KbUploadUrlSchema = z.object({
  folder_id: z.string().uuid().optional(),
  name: z.string().min(1),
  mime: z.string().default("application/octet-stream"),
  size_bytes: z.number().int().min(0).default(0),
});

export const KbExtractSchema = z.object({
  file_id: z.string().uuid(),
});

export const KbChunkSchema = z.object({
  file_id: z.string().uuid(),
  chunk_size_chars: z.number().int().min(100).max(8000).default(3200),
  overlap_chars: z.number().int().min(0).max(2000).default(200),
});

export const KbEmbedSchema = z.object({
  file_id: z.string().uuid(),
});

export const KbSearchSchema = z.object({
  query: z.string().min(1),
  folder_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(8),
});

// -- Apps ----------------------------------------------------------------

export const AppCreateSchema = z.object({
  name: z.string().min(1),
  tagline: z.string().default(""),
  description: z.string().default(""),
  icon: z.string().default("sparkles"),
  color: z.string().default("violet"),
  content_md: z.string().default(""),
});

export const AppUpdateSchema = AppCreateSchema.partial().extend({
  status: z.enum(["draft", "deployed"]).optional(),
});

export const AppDeploySchema = z.object({
  deployed_to: z.array(z.string().uuid()),
});

// -- Triggers ------------------------------------------------------------

export const TriggerCreateSchema = z.object({
  workflow_id: z.string().uuid(),
  kind: z.enum(["webhook", "schedule", "email_inbound", "manual"]),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export const TriggerUpdateSchema = TriggerCreateSchema.partial();
