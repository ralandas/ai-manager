import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmProvider, LlmTurnInput, ToolSchema } from './types.js';

const MAX_TOOL_HOPS = 6;

/**
 * Gemini provider using the current @google/genai SDK.
 *
 * Gemini 3.x tool-calling requires the model's function-call parts to be echoed
 * back verbatim (they carry a `thoughtSignature`). We do that by appending the
 * model's own `content` object to the history unchanged, then adding a matching
 * functionResponse part for each call.
 */
export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenAI;

  constructor() {
    if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
    this.client = new GoogleGenAI({
      apiKey: config.GEMINI_API_KEY,
      // Route through the local gemini-proxy when set (bypasses geo-block).
      ...(config.GEMINI_BASE_URL
        ? { httpOptions: { baseUrl: config.GEMINI_BASE_URL } }
        : {}),
    });
  }

  async runTurn(input: LlmTurnInput): Promise<string> {
    const toolIndex = new Map(input.tools.map((t) => [t.name, t]));

    const contents: Content[] = input.history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    const requestConfig = {
      systemInstruction: input.systemPrompt,
      tools: input.tools.length
        ? [{ functionDeclarations: input.tools.map(toDeclaration) }]
        : undefined,
    };

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      const response = await this.generateWithRetry({
        model: config.GEMINI_MODEL,
        contents,
        config: requestConfig,
      });

      const calls = response.functionCalls ?? [];
      if (calls.length === 0) {
        return response.text ?? '';
      }

      // Echo the model's function-call turn verbatim (preserves thoughtSignature).
      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);

      // Execute each tool and append a functionResponse part per call.
      const responseParts = await Promise.all(
        calls.map(async (c) => {
          const tool = c.name ? toolIndex.get(c.name) : undefined;
          let output: unknown;
          try {
            output = tool
              ? await tool.handler((c.args ?? {}) as Record<string, unknown>)
              : { error: `unknown tool ${c.name}` };
          } catch (err) {
            logger.error({ err, tool: c.name }, 'tool handler threw');
            output = { error: err instanceof Error ? err.message : String(err) };
          }
          return {
            functionResponse: {
              name: c.name ?? 'unknown',
              response: { result: output } as Record<string, unknown>,
            },
          };
        }),
      );
      contents.push({ role: 'user', parts: responseParts });
    }

    logger.warn({ hops: MAX_TOOL_HOPS }, 'gemini: tool-hop limit reached');
    return 'Извините, мне нужно уточнить детали. Секунду, я вернусь к вам.';
  }

  /**
   * generateContent with retries for transient failures. The gemini-proxy's
   * SOCKS upstream occasionally blips (502 "upstream Socket closed", timeouts);
   * without a retry a single blip would surface to the guest as an error.
   */
  private async generateWithRetry(
    req: Parameters<GoogleGenAI['models']['generateContent']>[0],
  ): ReturnType<GoogleGenAI['models']['generateContent']> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.client.models.generateContent(req);
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === MAX_ATTEMPTS) throw err;
        const backoff = 500 * attempt;
        logger.warn({ attempt, backoff }, 'gemini: transient error, retrying');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }
}

/** 502/503/504, timeouts, socket resets — worth retrying; 4xx (bad request) — not. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status && [500, 502, 503, 504].includes(status)) return true;
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

function toDeclaration(tool: ToolSchema): FunctionDeclaration {
  const properties: Record<string, { type: Type; description?: string; enum?: string[] }> = {};
  for (const [key, p] of Object.entries(tool.parameters.properties)) {
    properties[key] = {
      type: mapType(p.type),
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: Type.OBJECT,
      properties,
      required: tool.parameters.required,
    },
  };
}

function mapType(t: string): Type {
  switch (t) {
    case 'number':
      return Type.NUMBER;
    case 'integer':
      return Type.INTEGER;
    case 'boolean':
      return Type.BOOLEAN;
    default:
      return Type.STRING;
  }
}
