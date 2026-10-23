import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '../shared/types';
import type { Logger } from './logger';

/**
 * Everything that ties the bridge to a site's DOM. Each list is tried in order, so put
 * the most specific selector first and keep older ones as fallbacks. Users can override
 * any field without rebuilding: see docs/SELECTORS.md.
 */
export interface SiteSelectors {
  /** Page opened at startup and for logging in. */
  url: string;
  /** Page that starts a fresh conversation. */
  newChatUrl: string;
  /** Optional URL for a new chat with a specific model; "{model}" is replaced. */
  modelUrlTemplate?: string;
  /** The message box (textarea or contenteditable). */
  input: string[];
  sendButton: string[];
  /** Visible only while a reply is being generated. */
  stopButton: string[];
  /** One element per assistant reply. */
  assistantMessage: string[];
  /** Inside an assistant reply: the rendered Markdown body. Falls back to the whole reply. */
  assistantContent: string[];
  /**
   * Optional: matches the reply element itself once the site considers it finished. When set, a
   * reply only counts as complete when it matches (more reliable than the stop button alone).
   */
  replyComplete: string[];
  /** Present when the user is not signed in. */
  loggedOutMarkers: string[];
  /** The (usually hidden) file input behind the attach button. The best match for the files is used. */
  fileInput: string[];
  /** Case-insensitive phrases that indicate a usage limit when no reply arrives. */
  rateLimitPatterns: string[];
  /** Case-insensitive phrases of a "sign in to continue" wall shown instead of a reply. */
  loginWallPatterns: string[];
  /** A reply is complete once the stop button is gone and the text is unchanged for this long. */
  stableMs: number;
}

export const DEFAULT_SELECTORS: Record<ProviderId, SiteSelectors> = {
  chatgpt: {
    url: 'https://chatgpt.com/',
    newChatUrl: 'https://chatgpt.com/',
    modelUrlTemplate: 'https://chatgpt.com/?model={model}',
    input: [
      'textarea[name="prompt"]',
      'textarea[aria-label="Chat with ChatGPT"]',
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
    ],
    stopButton: [
      'button[aria-label="Stop generating"]',
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
    ],
    assistantMessage: ['li[data-message-role="assistant"]', '[data-message-author-role="assistant"]'],
    assistantContent: ['[data-assistant-markdown-root]', '.markdown'],
    replyComplete: ['[data-message-complete]'],
    loggedOutMarkers: ['[data-testid="login-button"]', 'button:has-text("Log in")'],
    fileInput: ['input[type="file"]'],
    rateLimitPatterns: [
      'message limit reached',
      'anonymous message limit',
      'you have reached',
      "you've reached",
      'you’ve reached',
      'usage cap',
      'hit your limit',
      'too many requests',
      'rate limit',
    ],
    loginWallPatterns: ['log in to continue', 'sign up to continue', 'log in or sign up'],
    stableMs: 1500,
  },
  grok: {
    url: 'https://grok.com/',
    newChatUrl: 'https://grok.com/',
    input: [
      'div.tiptap.ProseMirror[contenteditable="true"]',
      'textarea[aria-label="Ask Grok anything"]',
      'form textarea',
    ],
    sendButton: ['button[type="submit"][aria-label="Submit"]', 'button[aria-label="Submit"]', 'form button[type="submit"]'],
    stopButton: ['button[aria-label="Stop model response"]', 'button[aria-label="Stop"]'],
    assistantMessage: ['div.items-start .message-bubble', '[data-testid="assistant-message"]'],
    assistantContent: ['.response-content-markdown', '.markdown'],
    replyComplete: [],
    loggedOutMarkers: ['a[href*="sign-in"]', 'a[href*="accounts.x.ai"]', 'button:has-text("Sign in")'],
    fileInput: ['input[type="file"]'],
    rateLimitPatterns: ['message limit', 'reached your limit', 'rate limit', 'too many requests', 'upgrade to supergrok'],
    loginWallPatterns: ['sign up to continue', 'sign in to continue', 'continue your conversation'],
    stableMs: 1500,
  },
};

const KEYS = Object.keys(DEFAULT_SELECTORS.chatgpt) as (keyof SiteSelectors)[];

/**
 * Loads `<dataDir>/selectors/<id>.json` over the built-in defaults. The file is re-read
 * whenever it changes, so edits apply to the next message without restarting.
 */
export class SelectorStore {
  private cache = new Map<ProviderId, { mtime: number; value: SiteSelectors }>();

  constructor(
    readonly dir: string,
    private log: Logger,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    // Reference copies of the current defaults, refreshed on every start.
    for (const [id, value] of Object.entries(DEFAULT_SELECTORS)) {
      fs.writeFileSync(path.join(dir, `${id}.defaults.json`), JSON.stringify(value, null, 2));
    }
  }

  get(id: ProviderId): SiteSelectors {
    const file = path.join(this.dir, `${id}.json`);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // no override
    }
    const cached = this.cache.get(id);
    if (cached && cached.mtime === mtime) return cached.value;

    let value = DEFAULT_SELECTORS[id];
    if (mtime) {
      try {
        const override = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SiteSelectors>;
        const picked = Object.fromEntries(Object.entries(override).filter(([k]) => KEYS.includes(k as keyof SiteSelectors)));
        value = { ...value, ...picked };
        this.log.info(`[${id}] using selector overrides from ${file}`);
      } catch (e) {
        this.log.warn(`[${id}] ignoring invalid selector file ${file}:`, e);
      }
    }
    this.cache.set(id, { mtime, value });
    return value;
  }

  reload(): void {
    this.cache.clear();
  }
}
