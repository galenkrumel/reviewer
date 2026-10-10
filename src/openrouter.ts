// Real model adapter: OpenRouter's OpenAI-compatible chat completions with tools.
import type { ModelPort } from './ports.ts';

export function openRouter(apiKey: string): ModelPort {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return {
    async chat(req) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...req, usage: { include: true } }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${req.model}: ${res.status}`);
      const json = await res.json();
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error(`OpenRouter ${req.model}: no message in response`);
      const usage = json.usage ?? {};
      return {
        message,
        model: json.model ?? req.model,
        usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, cost: usage.cost ?? 0 },
      };
    },

    async listModels() {
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
      if (!res.ok) throw new Error(`OpenRouter model list: ${res.status}`);
      return (await res.json()).data;
    },
  };
}
