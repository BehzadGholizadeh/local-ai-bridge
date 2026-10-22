// The web UIs take one message at a time, so OpenAI-style message arrays (and app
// conversations that a provider joins midway) are flattened into a single prompt.

export interface PromptTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional speaker label, e.g. "ChatGPT" for an assistant turn. */
  name?: string;
}

export function buildPrompt(turns: PromptTurn[], globalSystem = ''): string {
  const system = [globalSystem, ...turns.filter((t) => t.role === 'system').map((t) => t.content)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
  const convo = turns.filter((t) => t.role !== 'system' && t.content.trim());
  const last = convo[convo.length - 1];
  if (!last) return system;
  const history = convo.slice(0, -1);
  if (!system && history.length === 0) return last.content;

  const parts: string[] = [];
  if (system) parts.push(`[Instructions]\n${system}`);
  if (history.length) {
    parts.push(
      `[Conversation so far]\n${history.map((t) => `${label(t)}: ${t.content.trim()}`).join('\n\n')}`,
    );
  }
  parts.push(`[Current message]\n${last.content}`);
  return parts.join('\n\n');
}

function label(t: PromptTurn): string {
  if (t.role === 'user') return 'User';
  return t.name ? `Assistant (${t.name})` : 'Assistant';
}

/** Extracts the text of an OpenAI message `content` (a string or an array of parts). */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Maps OpenAI chat messages (system/developer/user/assistant/tool) to prompt turns. */
export function openAiMessagesToTurns(messages: unknown[]): PromptTurn[] {
  const turns: PromptTurn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const { role, content } = m as { role?: string; content?: unknown };
    const text = contentToText(content);
    if (!text) continue;
    if (role === 'system' || role === 'developer') turns.push({ role: 'system', content: text });
    else if (role === 'assistant') turns.push({ role: 'assistant', content: text });
    else if (role === 'tool') turns.push({ role: 'user', content: `Tool result:\n${text}` });
    else turns.push({ role: 'user', content: text });
  }
  return turns;
}
