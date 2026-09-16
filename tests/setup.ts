// Contributor shells may contain real provider credentials or profile overrides.
// Remove only inherited provider settings before test modules load; individual
// fixtures can still set them explicitly with vi.stubEnv.
const providerPrefixes = ["ANTHROPIC_", "OPENAI_", "CODEX_", "CLAUDE_"];
for (const key of Object.keys(process.env)) {
  if (providerPrefixes.some(prefix => key.startsWith(prefix))) delete process.env[key];
}

export {};
