# CLAUDE.md: project memory and handoff

Read this first in every new session, on any machine. It records what the project is, how to
set it up, the decisions already made, where things stand, and what is still open. Keep it up
to date: when you finish a piece of work, update **Current status** and **Open issues**, then
commit and push.

Last updated: 2026-10-24 (after commit `cc59ef6`).

---

## 1. What this project is

**Local AI Bridge** (`https://github.com/BehzadGholizadeh/local-ai-bridge`, MIT). It lets the
user use **ChatGPT and Grok through their own signed-in browser sessions**, with no API keys:

1. **Desktop app** (Electron + React): chat with ChatGPT and Grok side by side.
2. **Local APIs** on `127.0.0.1:8080`: OpenAI-compatible (`/v1/chat/completions`, streaming),
   Ollama-compatible (`/api/chat`, `/api/generate`, `/api/tags`), and an **MCP server** (`/mcp`;
   tools `ask_chatgpt`, `ask_grok`, `status`; stdio adapter `local-ai-bridge mcp`).
3. **Local agent** (like Claude Code / Codex): ChatGPT or Grok is the "brain", and tools run on
   this computer (`read_file`, `write_file`, `edit_file`, `list_dir`, `search`, `bash`). Available
   in the app (sidebar **Agent**) and in the terminal (`node dist/cli.js agent "task"`).

The owner is Behzad Gholizadeh (GitHub `BehzadGholizadeh`). Main dev machine: Windows 11,
project at `E:\Projects\local-ai-bridge`.

## 2. Hard rules (decided; do not change without the owner asking)

- **No bot-detection evasion of any kind** (no stealth flags, no `navigator.webdriver` patching,
  no patchright/undetected browsers, no fingerprint spoofing) and **no account rotation** to get
  around usage limits. Sign-in instead happens in a *normal, non-automated* Chrome window
  ("Log in" button), which avoids Google's "browser may not be secure" and human-check loops.
- **No telemetry.** Data stays in the local data directory.
- The README keeps the **terms-of-service warning** (automating chatgpt.com / grok.com is likely
  against their ToS; personal use, own account, at own risk).
- Agent default permission mode is **ask** (writes, edits, shell commands and anything outside
  the workspace need approval). `full-auto` exists only as an explicit opt-in.
- **Commit after each piece of work** with a clear message (why, not just what); **push only
  when the owner says so**. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit the nested folder `local-ai-bridge/` (a stray second clone on the dev machine) or
  anything from the data directory (browser profiles hold session cookies).

## 3. Set up on a new machine

Requirements: **Node.js 20+** (tested with Node 24), npm 11, **Google Chrome or Microsoft Edge**
installed, git. TypeScript 7 is used (it removed `moduleResolution: node`; the configs use
`nodenext` / `bundler`).

```bash
git clone https://github.com/BehzadGholizadeh/local-ai-bridge.git
cd local-ai-bridge
npm install
npm start            # builds (tsc + vite) and opens the desktop app
```

- npm 11.16+ only runs install scripts the project allows; `package.json` has
  `"allowScripts": { "electron": true }`. If Electron's binary is missing:
  `node node_modules/electron/install.js`.
- No Chrome/Edge? `npm run install-browser`, then Settings → Browser → Bundled Chromium.
- First run: click **Log in** next to ChatGPT (and Grok), sign in in the normal Chrome window that
  opens, **close that window**; the bridge reconnects with the saved session.
- Sessions do **not** travel with the repo: each machine signs in once.

Useful commands:

```bash
npm run typecheck                    # both tsconfigs (core + renderer)
npm run build                        # tsc + vite
node dist/cli.js help
node dist/cli.js serve               # headless: API + MCP + Ollama, no UI
node dist/cli.js agent "task"        # terminal agent (uses a running app/serve if there is one)
node dist/cli.js smoke --send        # check the site selectors still work (fresh signed-out profile)
node dist/cli.js smoke --send --profile app   # same with the signed-in profiles (close the app first)
npm run dev                          # hot-reload development
npm run dist                         # installers via electron-builder (unsigned)
```

To test without touching the real data directory, set `LAB_DATA_DIR` to a scratch folder.

## 4. Where things live

Data directory (settings, history, browser profiles, logs): Windows `%APPDATA%\local-ai-bridge`,
macOS `~/Library/Application Support/local-ai-bridge`, Linux `~/.config/local-ai-bridge`.

- `settings.json`, `history.json` (Chat view conversations only)
- `profiles/chatgpt`, `profiles/grok`: browser profiles (cookies; never share)
- `selectors/*.defaults.json`; put overrides in `selectors/chatgpt.json` / `grok.json`
- `debug/`: screenshot + HTML saved when a send times out or a selector fails
- `agent-logs/*.jsonl`: **every agent run**, with exact prompts, the model's raw replies, tool
  calls and results (plus raw reply HTML when a reply names a tool but parses to no call).
  **Read the newest one first when the owner says an agent answer was wrong.**

Code map:

```
src/core/provider.ts     browser automation per site: launch, sign-in window, send (type → submit
                         with verification), reply detection, phases, dialogs, debug snapshots
src/core/selectors.ts    per-site selectors (signed-in AND signed-out ChatGPT layouts) + overrides
src/core/extract.ts      in-page: reply HTML → normalized HTML (code blocks rebuilt from innerText)
src/core/markdown.ts     HTML → Markdown (turndown + gfm)
src/core/server.ts       local HTTP server (host/origin/API-key checks, routing)
src/core/api/            openai.ts, ollama.ts, mcp.ts, completion.ts (shared runner), http.ts
src/core/chat.ts         Chat view conversations;  bridge.ts wires everything
src/agent/agent.ts       agent loop, grounding checks, events
src/agent/protocol.ts    first prompt, ```tool block format, tolerant parser, corrections
src/agent/tools/         read_file, write_file, edit_file, list_dir, search, bash
src/agent/permissions.ts ask / auto-edit / full-auto;  runlog.ts: agent-logs
src/agent/cli.ts         terminal agent;  src/main/agent-service.ts: agent in the app (IPC)
src/renderer/            React UI (ChatView, AgentView, SettingsView, ...)
src/cli.ts               `local-ai-bridge` command (serve, mcp, agent, smoke)
docs/SELECTORS.md        fixing selectors;  docs/COMPETITORS.md: similar projects + roadmap
```

## 5. How the agent works (essentials)

- Web chats have no function calling, so the model writes tool calls as fenced blocks:

  ````
  ```tool
  write_file
  path: notes/a.txt
  ---
  raw content, no escaping
  ```
  ````

  `edit_file` bodies use `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`. JSON blocks are also
  accepted and repaired. A task ends when a reply starts with `DONE:`.
- Before the first message the agent **lists the workspace itself** and includes the listing.
  The prompt says the computer is Windows, is not the model's sandbox, and lists the drives.
- Answers are rejected and corrected (max 2 each) when they: mention sandbox paths
  (`/mnt/data`, `/openai/`, `/workspace`); talk about files with no tool run; name files/folders
  never seen in tool output; or answer without a tool having touched a drive/path the task names
  ("drive E" → must run `list_dir E:/`).
- The parser accepts tool blocks with any or no language label, plain unfenced lines, escaped
  plain text, and calls whose line breaks were lost (`list_dir path: E:/ depth: 1`).
- UI/CLI show phases (opening → typing → sending → waiting → writing N chars, with seconds),
  each tool card says **ran on this computer** / **not run**, and text-only answers get a warning.
- **Chat view ≠ Agent.** Chat only relays to ChatGPT (no tools). Chat shows a banner with
  "Run as agent task" when a message looks like a task on this computer.

## 6. Current status (2026-10-24)

All work is committed and pushed; CI (GitHub Actions: typecheck + build on Windows, macOS,
Linux) passes. Verified:

- Desktop app, Chat view, OpenAI/Ollama/MCP APIs, attachments, smoke tests: work with
  **signed-out** ChatGPT (live) and offline checks.
- Agent: end-to-end live with signed-out ChatGPT (read → write → edit → PowerShell), approvals,
  phases, grounding corrections (scripted fake-model tests), run logs.
- Signed-in ChatGPT: selectors and reply extraction were fixed from the owner's failure
  snapshots and run log; the code-block fix (`cc59ef6`) was verified against the exact logged
  replies and reconstructed markups, **not yet live** with the signed-in account.

## 7. Open issues / next steps

1. **Confirm the agent live with the owner's signed-in ChatGPT**: restart the app, Agent →
   "go to drive E and list the folder names", allow `E:/`. Expected: a `list_dir E:/` card marked
   "ran on this computer" and the real folders. If wrong: read the newest
   `agent-logs/*.jsonl` (look at `exchange.reply` and `replyHtml`).
2. Signed-out ChatGPT now hits "You have reached the anonymous message limit" quickly (per
   network), so live testing needs a signed-in account.
3. **Grok**: signed-out Grok demands sign-in after the first message; its reply selectors
   (`div.items-start .message-bubble`, `.response-content-markdown`) are unverified signed-in.
   Run `smoke --send --profile app` after signing in.
4. Not started (see docs/COMPETITORS.md): Claude/Gemini/DeepSeek providers (wait until the
   owner can test selectors signed in), publishing to npm (`npx local-ai-bridge`), status
   dashboard, tool-calling emulation on the OpenAI API, model collaboration.

## 8. Troubleshooting checklist

- Agent "did nothing" / wrong answer → newest `agent-logs/*.jsonl`; check whether the task was
  run in **Chat** instead of **Agent** (Chat runs are in `history.json`).
- "No reply appeared" / "message typed but could not be sent" → `debug/*.png` + `.html`; often
  a dialog (sign-in wall, message limit) or a site markup change → update `src/core/selectors.ts`
  (or a runtime override) and run `smoke`.
- Transient `ERR_CONNECTION_RESET` on this network is common; navigation retries 3 times.
- Port 8080 busy → another app instance or `serve` is running (only one may hold the profiles).
