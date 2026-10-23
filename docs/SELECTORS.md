# Fixing selectors when ChatGPT or Grok changes

Local AI Bridge drives the real chatgpt.com and grok.com pages. When either site
changes its HTML, the bridge can stop finding the message box or the replies. You
can fix this **without rebuilding the app**, by editing a JSON file.

## Symptoms

| Error / status                                   | Selector to fix                          |
| ------------------------------------------------ | ---------------------------------------- |
| "Could not find the … message box"               | `input`                                  |
| "Could not type into the message box"            | `input`                                  |
| Prompt is typed but never sent                   | `sendButton`                             |
| "No reply appeared on …" but the answer is shown | `assistantMessage`                       |
| Reply arrives but text is empty / has UI junk    | `assistantContent`                       |
| Replies are cut off early                        | `stopButton` (or raise `stableMs`)       |
| Reply never "finishes" until the timeout         | `stopButton` matches something permanent |
| Always shows "Signed out" while signed in        | `loggedOutMarkers`                       |
| "offers no file upload here" while signed in     | `fileInput`                              |

## Find out what broke

```bash
node dist/cli.js smoke --send
```

It checks each selector against the live site and prints which one no longer matches (see the
README, "Selector smoke tests"). Add `--profile app` (with the app closed) to test with your
signed-in account, which some checks need.

## Where the files are

Settings → Browsers → **Open selectors folder**. It is `selectors/` inside the data
directory:

- Windows: `%APPDATA%\local-ai-bridge\selectors`
- macOS: `~/Library/Application Support/local-ai-bridge/selectors`
- Linux: `~/.config/local-ai-bridge/selectors`

It contains `chatgpt.defaults.json` and `grok.defaults.json`, rewritten on every start
with the built-in defaults (don't edit those).

## Override

1. Copy `chatgpt.defaults.json` to `chatgpt.json` (or `grok.defaults.json` to `grok.json`).
2. Edit only what you need. You may delete the other keys: missing keys fall back to
   the defaults. Arrays **replace** the default arrays.
3. Save. The file is re-read on the next message (or click **Reload**). No restart needed.

Each list is tried in order, first visible match wins, so put the new selector first
and keep the old ones as fallbacks:

```json
{
  "input": ["div#new-composer[contenteditable=true]", "#prompt-textarea"],
  "assistantMessage": ["[data-message-author-role=\"assistant\"]"]
}
```

Selectors use [Playwright syntax](https://playwright.dev/docs/locators): CSS plus extras
such as `button:has-text("Log in")`.

| Key                 | What it should match                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `url`               | Page opened at startup and for logging in                                  |
| `newChatUrl`        | Page that starts a fresh conversation                                      |
| `modelUrlTemplate`  | New chat with a model, `{model}` is replaced (ChatGPT: `?model={model}`)  |
| `input`             | The message box (textarea or contenteditable editor)                       |
| `sendButton`        | Send button (if none is clickable, the bridge presses Enter)               |
| `stopButton`        | Visible **only while** a reply is being generated                          |
| `assistantMessage`  | One element per assistant reply; the newest one is read                    |
| `assistantContent`  | Inside a reply: the rendered Markdown body                                 |
| `loggedOutMarkers`  | Anything visible only when signed out (e.g. a "Log in" button)            |
| `fileInput`         | The hidden `<input type="file">` behind the attach button; the one whose `accept` fits the files is used |
| `rateLimitPatterns` | Lowercase phrases shown when you hit a usage limit                         |
| `loginWallPatterns` | Lowercase phrases of a "sign in to continue" prompt shown instead of a reply |
| `stableMs`          | How long the text must stay unchanged after the stop button disappears     |

## Finding new selectors with Playwright codegen

Codegen opens a browser and shows a selector for whatever you click.

```bash
npx playwright-core codegen --channel chrome https://chatgpt.com
```

Use `--channel msedge` for Edge, or leave `--channel` out after `npm run install-browser`.

1. Sign in in the codegen window (it uses a temporary profile).
2. Click the **Pick locator** button, then hover the message box, the send button,
   a reply, and the stop button (send a long prompt to see it).
3. Prefer stable attributes: `data-testid`, `aria-label`, `id`, `data-message-author-role`.
   Avoid generated class names like `.css-1x2y3z`.
4. Put them in your override file.

You can also use DevTools in the bridge's own browser window: click **Show**, press
F12, and test a selector in the console with `document.querySelectorAll('…')`.

## Sharing a fix

If you fixed the selectors for a site change, please open a pull request that updates
`DEFAULT_SELECTORS` in [`src/core/selectors.ts`](../src/core/selectors.ts) so everyone
gets it.
