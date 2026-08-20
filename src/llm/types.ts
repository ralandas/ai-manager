/**
 * LLM abstraction. First implementation is Gemini; the agent depends only on
 * this interface, so swapping to Claude/OpenAI later means one new file.
 */

export interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  enum?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
  /** The actual implementation invoked when the model calls this tool. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface LlmTurnInput {
  systemPrompt: string;
  /** Prior turns, oldest first. */
  history: LlmMessage[];
  tools: ToolSchema[];
  /** Called with each tool name as the provider invokes it, so the agent can
   *  tell whether the turn actually did work (vs a "сейчас проверю" stub). */
  onToolCall?: (name: string) => void;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string };

export interface LlmProvider {
  /**
   * Runs one agent turn: the provider may call tools (multi-step) and returns
   * the final natural-language reply once it stops calling tools.
   */
  runTurn(input: LlmTurnInput): Promise<string>;
}
