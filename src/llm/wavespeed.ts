import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmProvider, LlmTurnInput, ToolSchema } from './types.js';

const MAX_TOOL_HOPS = 6;
const DEFAULT_BASE_URL = 'https://llm.wavespeed.ai/v1';

/**
 * WaveSpeed LLM provider — OpenAI-compatible Chat Completions.
 *
 * WaveSpeed exposes an OpenAI-shaped API at https://llm.wavespeed.ai/v1 with
 * Bearer auth and standard `tools` / `tool_calls` function calling (verified
 * against openai/gpt-5.4-mini). We talk to it with plain fetch to avoid pulling
 * in the OpenAI SDK, and run the same tool-hop loop the agent expects: keep
 * feeding tool results back until the model stops calling tools.
 */

/** OpenAI chat message shapes we send/receive. */
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { role: 'assistant'; content?: string | null; tool_calls?: ToolCall[] };
  }>;
  error?: { message?: string };
}

export class WaveSpeedProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    if (!config.WAVESPEED_API_KEY) throw new Error('WAVESPEED_API_KEY is required');
    this.apiKey = config.WAVESPEED_API_KEY;
    this.baseUrl = (config.WAVESPEED_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = config.WAVESPEED_MODEL ?? 'openai/gpt-5.4-mini';
  }

  async runTurn(input: LlmTurnInput): Promise<string> {
    const toolIndex = new Map(input.tools.map((t) => [t.name, t]));

    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map(
        (m): ChatMessage => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }),
      ),
    ];

    const tools = input.tools.length ? input.tools.map(toOpenAiTool) : undefined;

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      const res = await this.complete(messages, tools);
      const choice = res.choices?.[0];
      const msg = choice?.message;
      const calls = msg?.tool_calls ?? [];

      if (calls.length === 0) {
        return msg?.content ?? '';
      }

      // Echo the assistant's tool-call message, then one tool result per call.
      messages.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const tool = toolIndex.get(call.function.name);
        let output: unknown;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          output = tool
            ? await tool.handler(args as Record<string, unknown>)
            : { error: `unknown tool ${call.function.name}` };
        } catch (err) {
          logger.error({ err, tool: call.function.name }, 'tool handler threw');
          output = { error: err instanceof Error ? err.message : String(err) };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ result: output }),
        });
      }
    }

    logger.warn({ hops: MAX_TOOL_HOPS }, 'wavespeed: tool-hop limit reached');
    return 'Извините, мне нужно уточнить детали. Секунду, я вернусь к вам.';
  }

  /** POST /chat/completions with retries for transient upstream blips. */
  private async complete(messages: ChatMessage[], tools?: ReturnType<typeof toOpenAiTool>[]) {
    const body = JSON.stringify({
      model: this.model,
      messages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    });

    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(120_000),
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`wavespeed ${res.status}: ${text.slice(0, 300)}`) as Error & {
            status: number;
          };
          err.status = res.status;
          throw err;
        }
        return JSON.parse(text) as ChatCompletionResponse;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === MAX_ATTEMPTS) throw err;
        const backoff = 500 * attempt;
        logger.warn({ attempt, backoff }, 'wavespeed: transient error, retrying');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }
}

/** 5xx, timeouts, socket resets are worth retrying; 4xx (bad request) is not. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status && [500, 502, 503, 504, 429].includes(status)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('socket') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('bad gateway')
  );
}

/** Map our tool schema to the OpenAI function-tool shape. */
function toOpenAiTool(tool: ToolSchema) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object' as const,
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      },
    },
  };
}
