import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ProviderSchema = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof ProviderSchema>;
export const LoginModeSchema = z.enum(["device", "browser"]);
export const LoginSessionSchema = z.object({
  id: z.string(), accountId: z.string(), provider: ProviderSchema, mode: LoginModeSchema,
  status: z.enum(["starting", "waiting", "verifying", "complete", "error"]),
  authorizationUrl: z.string().nullable(), userCode: z.string().nullable(),
  canSubmitCode: z.boolean(), error: z.string().nullable(), expiresAt: z.string().nullable(),
});
export type LoginSession = z.infer<typeof LoginSessionSchema>;
export const AccountSchema = z.object({
  id: z.string(), provider: ProviderSchema, label: z.string(),
  source: z.enum(["managed", "system"]), email: z.string().nullable(),
  plan: z.string().nullable(), authStatus: z.enum(["ready", "needs_auth", "unknown", "error"]),
  createdAt: z.string(),
  login: z.union([z.object({sessionId:z.string(),mode:LoginModeSchema}),z.object({workspaceId:z.string(),terminalId:z.string()})]).nullable().optional(),
});
export type Account = z.infer<typeof AccountSchema>;
export const BindingSchema = z.object({
  agentId: z.string(), provider: ProviderSchema,
  currentAccountId: z.string().nullable(), pendingAccountId: z.string().nullable(),
  status: z.enum(["ready", "switching", "error"]), error: z.string().nullable(),
});
export type Binding = z.infer<typeof BindingSchema>;
export const StateSchema = z.object({
  accounts: z.array(AccountSchema), bindings: z.array(BindingSchema),
  defaults: z.object({ claude: z.string().nullable(), codex: z.string().nullable() }),
  integration: z.object({ enabled: z.boolean(), error: z.string().nullable() }),
});
export type AccountState = z.infer<typeof StateSchema>;
export const UsageWindowSchema = z.object({
  id: z.string(), label: z.string(), usedPercent: z.number().nullable(),
  windowDurationMins: z.number().nullable(), resetsAt: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export const UsageSnapshotSchema = z.object({
  accountId: z.string(), provider: ProviderSchema,
  status: z.enum(["ok", "stale", "needs_auth", "unavailable"]),
  plan: z.string().nullable(), windows: z.array(UsageWindowSchema),
  fetchedAt: z.string().nullable(), checkedAt: z.string(), nextRetryAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
const Empty = z.object({});
const AccountId = z.object({ accountId: z.string().min(1) });
export const listAccounts = defineRpc({ name: "accounts.list", input: Empty, output: StateSchema });
export const addAccount = defineRpc({ name: "accounts.add", input: z.object({ provider: ProviderSchema, label: z.string().trim().min(1).max(80) }), output: AccountSchema });
export const renameAccount = defineRpc({ name: "accounts.rename", input: AccountId.extend({ label: z.string().trim().min(1).max(80) }), output: AccountSchema });
export const removeAccount = defineRpc({ name: "accounts.remove", input: AccountId, output: Empty });
export const setDefaultAccount = defineRpc({ name: "accounts.default", input: z.object({ provider: ProviderSchema, accountId: z.string().nullable() }), output: Empty });
export const startLogin = defineRpc({ name: "auth.start", input: AccountId.extend({ mode: LoginModeSchema.optional() }), output: LoginSessionSchema });
export const getLoginStatus = defineRpc({ name: "auth.status", input: AccountId.extend({ sessionId: z.string().min(1) }), output: LoginSessionSchema });
export const submitLoginCode = defineRpc({ name: "auth.submit-code", input: AccountId.extend({ sessionId: z.string().min(1), code: z.string().trim().min(1).max(2048) }), output: LoginSessionSchema });
export const checkLogin = defineRpc({ name: "auth.check", input: AccountId, output: AccountSchema });
export const cancelLogin = defineRpc({ name: "auth.cancel", input: AccountId.extend({ sessionId: z.string().min(1).optional() }), output: AccountSchema });
export const prepareSwitch = defineRpc({ name: "switch.prepare", input: z.object({ agentId: z.string().min(1), accountId: z.string().nullable() }), output: BindingSchema });
export const applySwitch = defineRpc({ name: "switch.apply", input: z.object({ agentId: z.string().min(1) }), output: BindingSchema });
export const setIntegration = defineRpc({ name: "integration.set", input: z.object({ enabled: z.boolean() }), output: StateSchema });
export const listUsage = defineRpc({ name: "usage.list", input: z.object({ visible: z.boolean().optional() }), output: z.object({ accounts: z.array(UsageSnapshotSchema) }) });
export const refreshUsage = defineRpc({ name: "usage.refresh", input: z.object({ accountId: z.string().optional() }), output: z.object({ accounts: z.array(UsageSnapshotSchema) }) });
