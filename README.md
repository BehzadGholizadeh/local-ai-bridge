# Local AI Bridge

Use **ChatGPT** and **Grok** from a desktop app and from any OpenAI-compatible tool
(Cursor, Continue, OpenCode, scripts…), through **your own signed-in browser sessions**.
No API keys, no cloud relay: everything runs on your machine.

- Desktop app: send one message to ChatGPT, Grok, or both, and read the replies side by side as they stream in.
- Local API: `http://127.0.0.1:8080/v1/chat/completions`, OpenAI format, with streaming.
- Ollama-compatible API: `/api/chat`, `/api/generate`, `/api/tags` for Ollama-only tools.
- MCP server: `ask_chatgpt`, `ask_grok` and `status` tools for Claude Code, Cursor and other MCP clients.
- **Local agent** (like Claude Code / Codex): give it a task, ChatGPT or Grok plans, and tools
  (read/write/edit files, list folders, search, shell commands) run on your computer, with your approval.
- Sign in once in a real browser window; the session is kept in a local browser profile.

> [!WARNING]
> **Read before using.** This project automates the consumer websites chatgpt.com and grok.com.
> That is likely against the terms of service of OpenAI and xAI, and could get your account
> rate-limited or suspended. It is meant for personal use with your own account. It is not
> affiliated with or endorsed by OpenAI or xAI. If you need something reliable or commercial,
> use the official APIs. Use at your own risk.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [First sign-in](#first-sign-in)
- [Using the desktop app](#using-the-desktop-app)
- [Local agent](#local-agent)
- [Using the local API](#using-the-local-api)
- [Ollama-compatible API](#ollama-compatible-api)
- [Images and files](#images-and-files)
- [MCP server](#mcp-server)
- [Headless mode and CLI](#headless-mode-and-cli)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Building installers](#building-installers)
- [Project layout](#project-layout)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)
- [License](#license)

## How it works

```
 ┌─────────────────────────── Electron app (one Node process) ───────────────────────────┐
 │                                                                                       │
 │  React UI  ──IPC──►  Bridge core ──► ChatService (app conversations, history.json)    │
 │                          │                                                            │
 │  Cursor / scripts ─HTTP─►│ ApiServer  127.0.0.1:8080/v1  (OpenAI-compatible, SSE)     │
 │                          │                                                            │
 │                          ├─► WebChatProvider "chatgpt" ─Playwright─► Chrome window ──►│── chatgpt.com
 │                          └─► WebChatProvider "grok"    ─Playwright─► Chrome window ──►│── grok.com
 │                                     (persistent profiles in <data dir>/profiles/*)    │
 └───────────────────────────────────────────────────────────────────────────────────────┘
```

For each message the bridge types your prompt into the site's message box, clicks
Send, watches the newest reply element, converts its HTML back to Markdown and
streams it out until the site's Stop button disappears and the text stops changing.
All site-specific details (CSS selectors, URLs) live in one table that you can
override at runtime when a site changes, see [docs/SELECTORS.md](docs/SELECTORS.md).

### Tech stack

| Part             | Choice                                   | Why                                                                                                                       |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell    | **Electron**                             | Playwright needs a Node runtime. Electron ships one, so the UI, API server and automation run in a single process. With Tauri you'd ship and manage a separate Node sidecar plus the browser, which erases its size advantage here. |
| Automation       | **Playwright** (`playwright-core`)       | Persistent profiles, robust locators, CDP access. Uses your installed Chrome or Edge by default (no 150 MB download).     |
| UI               | **React 19 + Vite**, `react-markdown`    | Small, fast to build, standard.                                                                                           |
| API              | Node `http`, no framework                | Few dependencies; OpenAI-compatible JSON and SSE.                                                                         |
| HTML → Markdown  | `turndown` with rules for code and KaTeX | API clients get real code fences and tables.                                                                              |
| Language         | TypeScript everywhere                    |                                                                                                                           |

## Requirements

- **Node.js 20+** and npm (to run from source)
- **Google Chrome** or **Microsoft Edge** installed (recommended), or the bundled Chromium via `npm run install-browser`
- Windows 10/11, macOS 12+, or a Linux desktop
- A ChatGPT account and/or a Grok (X / xAI) account

## Install and run

```bash
git clone https://github.com/BehzadGholizadeh/local-ai-bridge.git
cd local-ai-bridge
npm install
npm start
```

`npm start` builds and opens the app. For development with hot reload use `npm run dev`.

> npm 11.16+ only runs install scripts that a project allows. `package.json` allows Electron's
> (it downloads the Electron binary). If `npm start` says Electron failed to install, run
> `node node_modules/electron/install.js`.

No Chrome or Edge? Run `npm run install-browser` once and choose **Bundled Chromium** in Settings → Browsers.

## First sign-in

1. Start the app. Two minimized browser windows open in the background (one per site).
2. In the top bar, click **Log in** next to ChatGPT. The automated window closes and a **normal**
   Chrome/Edge window opens on the same profile (sign-in pages and their "verify you are human"
   checks often refuse automated browsers, so you sign in in an ordinary one).
3. Sign in as you normally would (email/password, Google, Microsoft, Apple…), including any 2FA.
4. **Close that browser window.** The bridge restarts its automated window with your saved session,
   and the status turns **Ready** within a few seconds.
5. Repeat for Grok.

Sessions are stored in the local profiles, so you only do this again when the site logs you out.
If the status says the profile is already open in another window, close every window of that
profile and click **Log in** again.

## Using the desktop app

- **New chat** starts a conversation. Pick **ChatGPT**, **Grok** or both with the chips above the message box.
- Replies stream side by side. **Stop** cancels (it also clicks Stop on the site).
- Follow-ups continue the same conversation on each site. If you add a model mid-conversation,
  it gets the earlier turns as context.
- History is saved locally. Double-click a chat in the sidebar to rename it; × deletes it from local history
  (the conversation on chatgpt.com/grok.com is not deleted).
- **Show** / **Hide** bring the automated browser window forward or minimize it. ↻ restarts it.
- The ◐ button cycles System → Light → Dark theme.
- Closing the window keeps the app (and the API) running in the system tray. Use the tray menu → Quit to exit.

## Local agent

An agent in the style of Claude Code / Codex: you give it a task, ChatGPT or Grok (through your
browser session) decides what to do, and tools run **on your computer**. It repeats
"think → call tools → read results" until the task is done, showing each step.

```bash
node dist/cli.js agent "List the files in this folder and summarize what this project does"
node dist/cli.js agent --cwd ~/Desktop "Open title.pptx and change the first slide's title to 'Q3 Review'"
node dist/cli.js agent --provider grok --mode auto-edit "Rename all .jpeg files here to .jpg"
node dist/cli.js agent          # asks for a task; after it finishes you can give follow-ups
```

**Tools:** `read_file`, `write_file`, `edit_file` (exact text replacement), `list_dir`, `search`
(regex across files) and `bash` (PowerShell on Windows, your shell elsewhere). Office and other
binary files are handled with scripts through `bash` (e.g. Python with python-pptx), which the agent
checks for and can install.

**Permissions.** The model's instructions can be influenced by the files and command output it
reads, so the agent asks before it changes anything:

| Mode (`--mode`)  | Runs without asking | Asks first |
| ---------------- | ------------------- | ---------- |
| `ask` (default)  | reading and searching inside the workspace | writes, edits, every shell command, anything outside the workspace |
| `auto-edit`      | the above + writes and edits inside the workspace | shell commands, anything outside the workspace |
| `full-auto`      | everything | nothing: only for tasks and folders you trust |

At a prompt: `y` allows once, `a` allows that tool for the rest of the session, `n` denies (the
model is told and must take another approach). Writes show the new content and edits show a diff
before you decide. The workspace is `--cwd` (default: the current folder).

**How it works.** The web chats have no function-calling API, so the agent uses a text protocol:
the first message explains the tools and asks the model to call them with fenced ```` ```tool ````
JSON blocks; the agent runs them and sends the results back as the next message in the **same**
conversation (`src/agent/protocol.ts`, `src/agent/agent.ts`). When a reply contains no tool block,
the task is done. If the app or `serve` is already running, the CLI agent uses it over its MCP
endpoint (so it can share the signed-in browser); otherwise it drives the browser itself
(`--in-process` forces that).

Notes: each step is a full web-chat round trip (a few seconds), so the agent is slower than API-based
agents; signed-out ChatGPT has a small message allowance, so sign in for real work; Ctrl+C stops the
current task.

## Using the local API

Base URL: `http://127.0.0.1:8080/v1` (the port is configurable).

| Model id                 | Goes to                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `chatgpt`                | ChatGPT, site default model (or the model set in Settings)                         |
| `chatgpt/<slug>`         | ChatGPT with a model chosen by URL, e.g. `chatgpt/gpt-4o`                          |
| `gpt-*`, `o1`, `o3`, ... | Same as `chatgpt/<that slug>`, so tools with hard-coded OpenAI model names work    |
| `grok`, `grok-*`         | Grok (site default model)                                                          |

Endpoints:

- `POST /v1/chat/completions`: `stream: true` (SSE) and non-streaming
- `GET /v1/models`
- `GET /health`, `GET /v1/bridge/status`: provider status (logged in, rate limited…)

Each API request opens a **new** chat on the site; the whole `messages` array (system prompt,
history, last message) is flattened into one prompt. Requests to the same provider are queued
and answered one at a time. Parameters such as `temperature`, `max_tokens` and `tools` are ignored.

### curl

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"grok","stream":true,"messages":[{"role":"user","content":"Explain CRDTs in 3 sentences"}]}'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="anything")  # or your key from Settings
stream = client.chat.completions.create(
    model="chatgpt",
    messages=[{"role": "user", "content": "Write a haiku about local-first software"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Cursor

Settings → Models → **OpenAI API Key**: enter any value (or your bridge key), enable
**Override OpenAI Base URL** and set `http://127.0.0.1:8080/v1`, then add a custom model named
`chatgpt` or `grok`. Note: features that Cursor routes through its own servers cannot reach a
localhost URL; plain chat with a custom model works best.

### Continue (VS Code / JetBrains)

`~/.continue/config.yaml`:

```yaml
models:
  - name: ChatGPT (web)
    provider: openai
    model: chatgpt
    apiBase: http://127.0.0.1:8080/v1
    apiKey: anything
  - name: Grok (web)
    provider: openai
    model: grok
    apiBase: http://127.0.0.1:8080/v1
    apiKey: anything
```

### OpenCode

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local AI Bridge",
      "options": { "baseURL": "http://127.0.0.1:8080/v1" },
      "models": { "chatgpt": { "name": "ChatGPT (web)" }, "grok": { "name": "Grok (web)" } }
    }
  }
}
```

Agentic tools that rely on function/tool calling won't work well: the web UIs don't expose tool calls.

### Errors

Errors use the OpenAI shape `{"error": {"message", "type", "code"}}`. In a stream, the error
arrives as a `data:` event followed by `[DONE]`.

| HTTP | `code`            | Meaning / what to do                                                    |
| ---- | ----------------- | ----------------------------------------------------------------------- |
| 503  | `logged_out`      | Open the app and click **Log in**                                       |
| 503  | `challenge`       | Cloudflare check: click **Show** and complete it                        |
| 429  | `rate_limited`    | The site's usage limit; wait or switch model                            |
| 504  | `timeout`         | No complete reply within the timeout (Settings → Reply timeout)        |
| 502  | `selector`        | The site changed, see [docs/SELECTORS.md](docs/SELECTORS.md)            |
| 503  | `browser_missing` | Install Chrome/Edge or run `npm run install-browser`                    |
| 503  | `disabled`        | Provider disabled in Settings                                           |
| 502  | `upload_failed`   | The site offers no matching upload (e.g. a PDF while signed out) or the upload didn't finish |
| 451  | `blocked`         | The site isn't available in your country/region                         |
| 401  | `invalid_api_key` | Wrong bearer token                                                      |

## Ollama-compatible API

For tools that only speak Ollama (Open WebUI, Continue's `ollama` provider, Raycast, Obsidian
plugins…). The Ollama endpoints are always served on the main port, so set the client's Ollama URL
to `http://127.0.0.1:8080`. For clients that insist on Ollama's default `http://localhost:11434`,
set **Settings → Ollama port** to `11434` (only if the real Ollama isn't running on it).

| Endpoint             | Notes                                                         |
| -------------------- | ------------------------------------------------------------- |
| `POST /api/chat`     | Streams NDJSON by default, like Ollama; `"stream": false` for one object |
| `POST /api/generate` | `prompt` + optional `system`                                  |
| `GET /api/tags`      | Lists `chatgpt:latest` and `grok:latest`                      |
| `POST /api/show`     | Basic model details                                           |
| `GET /api/version`, `GET /api/ps` | For client health checks                         |

Model names: `chatgpt`, `chatgpt:latest`, `chatgpt:<model-slug>` (e.g. `chatgpt:gpt-4o`), `grok`, `grok:latest`.
Options such as `temperature`, `num_ctx` and `keep_alive` are ignored. Pull, push, create and
embedding endpoints aren't supported.

```bash
curl http://127.0.0.1:8080/api/chat -d '{"model":"chatgpt","messages":[{"role":"user","content":"Hello!"}]}'
```

## MCP server

The bridge is also a [Model Context Protocol](https://modelcontextprotocol.io) server, so agents
can ask ChatGPT or Grok for a second opinion. It runs inside the app (or the headless server):
keep one of them running.

| Tool          | Arguments                                   | Returns                                                     |
| ------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `ask_chatgpt` | `prompt`, optional `model`, `chat_url`, `files` | The reply as Markdown, plus `chat_url` to continue the chat |
| `ask_grok`    | `prompt`, optional `chat_url`, `files`      | Same                                                        |

`files` is a list of absolute paths of local files or images to attach. Your MCP client normally
shows the arguments (including these paths) before running a tool call; review them, since the
files are uploaded to the site.
| `status`      | none                                        | Ready / signed out / rate limited / needs check, per site   |

Each call starts a new chat unless you pass the `chat_url` from an earlier result. Only URLs on
chatgpt.com / grok.com are accepted as `chat_url`. The system prompt from Settings applies to new chats.

**Over HTTP** (Streamable HTTP, recommended): `http://127.0.0.1:8080/mcp`

```bash
claude mcp add --transport http local-ai-bridge http://127.0.0.1:8080/mcp
```

If you set an API key, add `--header "Authorization: Bearer <key>"`.

Cursor (`~/.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "local-ai-bridge": { "url": "http://127.0.0.1:8080/mcp" }
  }
}
```

**Over stdio**, for clients that only launch commands. `dist/mcp-stdio.js` forwards to the running
bridge and reads the port and API key from the bridge's `settings.json` (override with `--port`,
`LAB_PORT`, `LAB_API_KEY`):

```bash
claude mcp add local-ai-bridge -- node /path/to/local-ai-bridge/dist/mcp-stdio.js
```

```json
{
  "mcpServers": {
    "local-ai-bridge": { "command": "node", "args": ["/path/to/local-ai-bridge/dist/mcp-stdio.js"] }
  }
}
```

Replies can take a while (requests to the same site queue up). If your client times out tool
calls, raise its limit (Claude Code: `MCP_TOOL_TIMEOUT=300000`).

## Images and files

Attachments are uploaded through the site's own attach button (its hidden file input), then the
bridge waits for the upload to finish before sending. Up to 10 files per message, 25 MB each.

- **Desktop app:** 📎 button, paste an image, or drag files onto the message box.
- **OpenAI API:** `image_url` parts (data URLs, or http(s) URLs that the bridge downloads) and `file`
  parts with `file_data`:

  ```json
  {"model": "chatgpt", "messages": [{"role": "user", "content": [
    {"type": "text", "text": "What's in this picture?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0..."}}
  ]}]}
  ```

- **Ollama API:** `images` (base64) on a message or on `/api/generate`.
- **MCP:** the `files` argument of `ask_chatgpt` / `ask_grok`.

What a site accepts depends on your account: signed-out ChatGPT takes images only. Attachments from
every message in an API request are uploaded with the new chat.

## Headless mode and CLI

The `local-ai-bridge` command runs the bridge without the desktop UI (API, Ollama endpoints and MCP),
the MCP stdio adapter, and the selector smoke tests. It shares settings and logins with the desktop app.

From a clone, build once and use `node dist/cli.js` (or `npm link` to get a global `local-ai-bridge`):

```bash
npm run build
node dist/cli.js serve                          # API on the configured port (also: npm run server)
node dist/cli.js serve --port 9000              # different port (saved to settings)
node dist/cli.js serve --ollama-port 11434      # also listen on Ollama's default port (saved)
node dist/cli.js serve --login chatgpt          # open the sign-in window
node dist/cli.js serve --show                   # keep browser windows visible
node dist/cli.js mcp                            # MCP over stdio → running bridge
node dist/cli.js smoke                          # check the selectors (see Troubleshooting)
node dist/cli.js help
```

Once the package is published to npm, the same commands work without cloning:
`npx local-ai-bridge serve`, `npx local-ai-bridge mcp`, `npx local-ai-bridge smoke`. The npm package
contains only the headless parts; it uses your installed Chrome or Edge.

### Selector smoke tests

`smoke` opens each site and checks that the selectors still match. By default it uses a fresh,
signed-out temporary profile and sends nothing: it checks the page, the message box, the send button
(by typing and clearing a word) and the file input.

```bash
node dist/cli.js smoke                          # both sites, nothing sent
node dist/cli.js smoke --send                   # also send one short test message ("pong")
node dist/cli.js smoke --send --profile app     # use your signed-in profiles (close the app first)
node dist/cli.js smoke --provider grok --json   # one site, machine-readable output
```

`--send` checks the reply, stop-button and Markdown selectors end to end. A site that requires
signing in (signed-out Grok does) is reported as a warning, not a failure; use `--profile app` to
test with your account. The exit code is non-zero when a required check fails.

## Settings

Stored in `settings.json` in the data directory.

| Setting                    | Default    | Notes                                                                    |
| -------------------------- | ---------- | ------------------------------------------------------------------------ |
| Port                       | `8080`     | API listens on 127.0.0.1 only                                            |
| Ollama port                | off        | Extra port for Ollama clients, e.g. `11434`                              |
| API key                    | empty      | If set, clients must send `Authorization: Bearer <key>`                  |
| Allowed origins            | empty      | Browser origins allowed to call the API (CORS). Desktop tools need none  |
| System prompt              | empty      | Added to the first message of every new chat, app and API                |
| ChatGPT model              | empty      | Slug for new ChatGPT chats, e.g. `gpt-4o`                                |
| Reply timeout              | 300 s      |                                                                          |
| Providers                  | both on    |                                                                          |
| Browser                    | Auto       | Chrome → Edge → bundled Chromium                                         |
| Show browser windows       | off        | Off = windows start minimized                                            |
| Start browsers on open     | on         |                                                                          |
| Keep running in tray       | on         |                                                                          |
| Start on login             | off        | Installed app on Windows/macOS                                           |
| Theme                      | System     |                                                                          |

Data directory (override with the `LAB_DATA_DIR` environment variable):

- Windows: `%APPDATA%\local-ai-bridge`
- macOS: `~/Library/Application Support/local-ai-bridge`
- Linux: `~/.config/local-ai-bridge`

It contains `settings.json`, `history.json`, `selectors/` and `profiles/` (your browser sessions:
treat this folder like a password).

## Troubleshooting

**"Message box not found" / "No reply appeared" / replies cut off: selector drift.**
The sites change their HTML regularly. Run `node dist/cli.js smoke --send` to see which selector
broke. Then open Settings → Browsers → **Open selectors folder**,
copy `chatgpt.defaults.json` to `chatgpt.json` (or the Grok one), fix the selectors and save.
No restart needed. Find new selectors with:

```bash
npx playwright-core codegen --channel chrome https://chatgpt.com
```

Full guide: [docs/SELECTORS.md](docs/SELECTORS.md). Please send a PR with working selectors.

**Sign-in keeps failing / "verify you are human" loops.** Use **Log in** (it opens a normal,
non-automated browser window); don't sign in through **Show**.

**Status "Needs check" (Cloudflare / "Just a moment…").** Click **Log in** (or **Show**) and complete
the check in the browser window. Using your installed Chrome (Settings → Browser) and keeping one session
per site, signed in, makes this rarer. The bridge does not try to bypass these checks.

**Status "Rate limited".** You hit the site's usage cap for your plan. Wait until it resets,
pick another model, or send to the other provider.

**Stuck on "Starting" / "No usable browser".** Install Chrome or Edge, or run
`npm run install-browser` and choose Bundled Chromium. If the error mentions the profile being
in use, another copy of the app (or the headless server) is running: close it.

**"Port 8080 is already in use".** Change the port in Settings → Local API.

**A reply is complete in the browser but the app keeps "answering…".** The `stopButton`
selector probably matches an element that's always visible. Fix it in your override file.

**Browser window keeps popping up.** Turn off Settings → Show browser windows, or click **Hide**.

**See what the browser saw.** When a message times out or a selector fails, the bridge saves a
screenshot and the page HTML to `<data dir>/debug/` (the last 10 failures per site) and logs the path.

**Reset everything.** Quit the app and delete the data directory (this signs you out).

Logs: Settings → Logs, or the terminal when running from source.

## Building installers

```bash
npm run dist
```

Produces installers in `release/` (NSIS on Windows, DMG on macOS, AppImage/deb on Linux) via
electron-builder. Build on the target OS. Builds are unsigned: Windows SmartScreen and macOS
Gatekeeper will warn (on macOS: right-click → Open).

## Project layout

```
src/
  shared/types.ts        types shared by core and UI
  core/
    bridge.ts            wires settings, history, providers, API server
    provider.ts          Playwright automation for one site (login state, send, stream)
    selectors.ts         per-site selectors + runtime override loader
    server.ts            local HTTP server: security checks and routing
    api/completion.ts    model names → provider, queued request with streaming deltas
    api/openai.ts        OpenAI-compatible /v1 endpoints (SSE streaming)
    api/mcp.ts           MCP server (Streamable HTTP at /mcp)
    api/ollama.ts        Ollama-compatible /api endpoints (NDJSON streaming)
    chat.ts              app conversations, fan-out to several providers
    prompt.ts            flattens message lists into one prompt
    attachments.ts       images/files from API requests, MCP paths and the app (limits, MIME types)
    markdown.ts          reply HTML → Markdown
    history.ts settings.ts logger.ts errors.ts mutex.ts paths.ts
  main/main.ts           Electron main process: window, tray, IPC
  main/preload.ts        safe IPC bridge for the renderer
  renderer/              React UI (Vite)
  cli.ts                 local-ai-bridge command (serve, mcp, smoke)
  headless.ts            serve: the bridge without the desktop UI
  smoke.ts               selector smoke tests
  agent/agent.ts         agent loop: model → tool calls → permission check → results → model
  agent/protocol.ts      system prompt, ```tool block parsing, result messages
  agent/backend.ts       the "brain": in-process browser, or a running bridge over MCP
  agent/permissions.ts   ask / auto-edit / full-auto approval rules
  agent/tools/           read_file, write_file, edit_file, list_dir, search, bash
  agent/cli.ts           local-ai-bridge agent
  mcp-stdio.ts           MCP over stdio, forwards to the running bridge
docs/SELECTORS.md        how to fix selectors
scripts/gen-icon.mjs     regenerates assets/icon.png
```

## Security and privacy

- No telemetry, no analytics, no update checks. The only network traffic is the browsers talking to chatgpt.com / grok.com (and their sign-in providers).
- The API binds to `127.0.0.1` only, rejects requests whose `Host` isn't a loopback name (DNS rebinding),
  and rejects browser requests from origins you haven't allowed (so websites you visit can't use your sessions).
- Any program on your computer can reach the API unless you set an **API key**. Set one if you share the machine.
- The renderer is sandboxed with context isolation; links open in your normal browser.
- `profiles/` holds your session cookies. Don't sync or share it.

## Limitations

- Voice, canvas, image generation output and tool calls aren't supported. Attachments go in, but
  images the site generates don't come back through the API.
- Signed-out ChatGPT only accepts image attachments; other files need you to sign in.
- One reply at a time per provider (requests queue).
- ChatGPT guest (signed-out) chats don't survive a browser restart. When a saved web chat turns out
  empty, the app resends the earlier turns as context, so follow-ups still work.
- Grok is not available in some countries; the status bar then shows "not available in your region".
- Choosing a Grok model isn't supported yet; ChatGPT models are chosen by URL (`?model=`), which works for most but not all models.
- Token counts in `usage` are estimates (characters / 4).
- Streaming over the API holds back the last ~64 characters until they're stable, because rendered Markdown can still change at the end.
- It will break when the sites change. That's what the selector overrides are for.

## Contributing

See [docs/COMPETITORS.md](docs/COMPETITORS.md) for similar projects and the roadmap.

Issues and PRs welcome, especially selector updates. Run `npm run typecheck` before opening a PR.

## License

[MIT](LICENSE)
