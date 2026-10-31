import { AnthropicClient } from "./anthropic.js";
import { OpenAiCompatClient } from "./openai-compat.js";
import { OpenAiResponsesClient } from "./openai-responses.js";
import type { LlmClient, ProviderConfig } from "./types.js";

/** transport：chat = /v1/chat/completions（或 Anthropic Messages），responses = /v1/responses（对话可以存在后端，仅 OpenAI 兼容接口） */
export function createClient(cfg: ProviderConfig, transport: "chat" | "responses" = "chat"): LlmClient {
	if (transport === "responses") {
		if (cfg.kind !== "openai-compat") throw new Error("/v1/responses 只适用于 OpenAI 兼容接口，Anthropic Messages 没有“后端保存对话”的接口");
		return new OpenAiResponsesClient(cfg);
	}
	return cfg.kind === "anthropic" ? new AnthropicClient(cfg) : new OpenAiCompatClient(cfg);
}
