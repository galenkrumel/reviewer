// Real model adapter: OpenRouter's OpenAI-compatible chat completions with tools.
import type { ModelPort } from './ports.ts';

export function openRouter(apiKey: string): ModelPort {
  return {
    async chat(req) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`OpenRouter ${req.model}: ${res.status}`);
      const message = (await res.json()).choices?.[0]?.message;
      if (!message) throw new Error(`OpenRouter ${req.model}: no message in response`);
      return message;
    },
  };
}
