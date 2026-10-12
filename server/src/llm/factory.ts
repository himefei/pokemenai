import { AnthropicClient } from "./anthropic.js";
import { OpenAiCompatClient } from "./openai-compat.js";
import type { LlmClient, ProviderConfig } from "./types.js";

export function createClient(cfg: ProviderConfig): LlmClient {
	return cfg.kind === "anthropic" ? new AnthropicClient(cfg) : new OpenAiCompatClient(cfg);
}
