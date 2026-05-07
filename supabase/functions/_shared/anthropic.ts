// Thin wrapper around the Anthropic SDK. Centralises the beta header so every
// call goes through the same configured client. Each method here mirrors a
// specific Managed Agents endpoint we expose to our own clients.

import Anthropic from "npm:@anthropic-ai/sdk@0.30.1";
import { ENV } from "./env.ts";
import { Upstream } from "./errors.ts";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!_client) {
    if (!ENV.ANTHROPIC_API_KEY) {
      throw new Upstream("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({
      apiKey: ENV.ANTHROPIC_API_KEY,
      defaultHeaders: {
        "anthropic-beta": ENV.ANTHROPIC_BETA_HEADER,
      },
    });
  }
  return _client;
}

// The SDK's beta resource is loosely typed in the current beta release. We
// expose narrow types so call sites stay typed end to end.
type Json = Record<string, unknown>;

export type AgentCreateInput = {
  name: string;
  model: string;
  system?: string;
  tools?: Json[];
  mcp_servers?: Json[];
  skills?: Json[];
  multiagent?: Json;
  description?: string | null;
  metadata?: Record<string, string>;
};

export type AgentUpdateInput = Partial<AgentCreateInput> & { version: number };

export type EnvironmentCreateInput = {
  name: string;
  config?: Json;
};

export type SessionCreateInput = {
  agent: string | { type: "agent"; id: string; version?: number };
  environment_id: string;
  vault_ids?: string[];
  title?: string;
};

// All Anthropic Managed Agents methods live on `client.beta`. The SDK ships
// strong types for these, but to keep the wrapper portable across SDK
// minor versions we cast via `unknown` at the entry point. Each method is
// a thin pass-through; nothing else in the codebase calls Anthropic.

// deno-lint-ignore no-explicit-any
function beta(): any {
  return (anthropic() as any).beta;
}

export const AnthropicAgents = {
  create: (input: AgentCreateInput) => beta().agents.create(input),
  retrieve: (id: string) => beta().agents.retrieve(id),
  update: (id: string, input: AgentUpdateInput) => beta().agents.update(id, input),
  archive: (id: string) => beta().agents.archive(id),
  list: () => beta().agents.list(),
};

export const AnthropicEnvironments = {
  create: (input: EnvironmentCreateInput) => beta().environments.create(input),
  retrieve: (id: string) => beta().environments.retrieve(id),
  archive: (id: string) => beta().environments.archive(id),
  delete: (id: string) => beta().environments.delete(id),
  list: () => beta().environments.list(),
};

export const AnthropicSessions = {
  create: (input: SessionCreateInput) => beta().sessions.create(input),
  retrieve: (id: string) => beta().sessions.retrieve(id),
  archive: (id: string) => beta().sessions.archive(id),
  delete: (id: string) => beta().sessions.delete(id),
  list: () => beta().sessions.list(),
};

export type UserEvent =
  | {
    type: "user.message";
    content: Array<{ type: "text"; text: string }>;
  }
  | { type: "user.interrupt"; session_thread_id?: string }
  | {
    type: "user.define_outcome";
    description: string;
    rubric: { type: "text"; content: string } | { type: "file"; file_id: string };
    max_iterations?: number;
  }
  | {
    type: "user.tool_confirmation";
    tool_use_id: string;
    result: "allow" | "deny";
    deny_message?: string;
  }
  | {
    type: "user.custom_tool_result";
    custom_tool_use_id: string;
    content: Array<{ type: "text"; text: string }>;
  };

export const AnthropicSessionEvents = {
  send: (sessionId: string, events: UserEvent[]) =>
    beta().sessions.events.send(sessionId, { events }),
  list: (sessionId: string, params?: { types?: string[] }) =>
    beta().sessions.events.list(sessionId, params ?? {}),
  // Returns an async-iterable stream of events.
  stream: (sessionId: string) => beta().sessions.events.stream(sessionId),
};

export const AnthropicSkills = {
  create: (input: { display_name: string; description?: string }) =>
    beta().skills.create(input),
  upload_version: (skillId: string, file: Blob) =>
    beta().skills.versions.upload(skillId, { file }),
  list: () => beta().skills.list(),
  retrieve: (id: string) => beta().skills.retrieve(id),
  archive: (id: string) => beta().skills.archive(id),
};

export const AnthropicVaults = {
  create: (input: { display_name: string; metadata?: Record<string, string> }) =>
    beta().vaults.create(input),
  retrieve: (id: string) => beta().vaults.retrieve(id),
  archive: (id: string) => beta().vaults.archive(id),
  list: () => beta().vaults.list(),
};

export const AnthropicVaultCredentials = {
  create: (
    vaultId: string,
    input: { display_name: string; auth: Json },
  ) => beta().vaults.credentials.create(vaultId, input),
  archive: (vaultId: string, credentialId: string) =>
    beta().vaults.credentials.archive(credentialId, { vault_id: vaultId }),
};

export const AnthropicWebhooks = {
  // Verifies the X-Webhook-Signature header against ANTHROPIC_WEBHOOK_SIGNING_KEY
  // and returns the parsed event. Throws on invalid signature.
  unwrap: (body: string, headers: Record<string, string>) => {
    if (!ENV.ANTHROPIC_WEBHOOK_SIGNING_KEY) {
      throw new Upstream("ANTHROPIC_WEBHOOK_SIGNING_KEY is not set");
    }
    const client = new Anthropic({
      apiKey: ENV.ANTHROPIC_API_KEY,
      // The SDK reads the signing key from this option.
      // deno-lint-ignore no-explicit-any
      ...(({ webhookSigningSecret: ENV.ANTHROPIC_WEBHOOK_SIGNING_KEY }) as any),
      defaultHeaders: { "anthropic-beta": ENV.ANTHROPIC_BETA_HEADER },
    });
    // deno-lint-ignore no-explicit-any
    return (client as any).beta.webhooks.unwrap(body, headers);
  },
};

export type { Json };
