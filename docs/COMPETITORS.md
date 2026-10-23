# Similar projects and roadmap

A survey of comparable open-source projects (October 2026) and the ideas worth adopting in
Local AI Bridge, with the roadmap's current status. Star counts are approximate, as noted at the
time of the survey; check the repositories for current details.

**Out of scope, by decision:** bot-detection evasion of any kind (hiding automation from sign-in or
Cloudflare checks, patched "undetectable" browser builds, fingerprint spoofing) and rotating several
accounts to get around usage limits. Sign-in instead happens in a normal, non-automated browser
window (see the README, "First sign-in"), and usage limits are reported to the user as they are.

## Where Local AI Bridge stands

- Desktop app (Electron + React) and a headless CLI, both local-only.
- ChatGPT and Grok through the user's own signed-in browser profiles.
- OpenAI-compatible API, Ollama-compatible API and an MCP server.
- Image and file attachments through the sites' attach buttons.
- Runtime-editable selectors with smoke tests to detect site changes.

## Similar projects

### Closest matches

| Project | Approx. stars | Stack | Ideas worth considering |
| ------- | ------------- | ----- | ----------------------- |
| [multi-ai-chat-desktop](https://github.com/TED-H-com/multi-ai-chat-desktop) | ~158 | Tauri 2 | Polished multi-model GUI, models collaborating on an answer, ready-made installers, 4 models |
| [CatGPT-Gateway](https://github.com/GautamVhavle/CatGPT-Gateway) | ~307 | Playwright | Tool calling, vision and file upload over a complete API |
| [WebModel](https://github.com/linuxhsj/WebModel) | ~102 | Node | 11 models, web dashboard, both OpenAI and Anthropic request formats |
| [NexGate](https://github.com/0xfunboy/NexGate) | small | Playwright + Fastify | Real-time status dashboard, OpenAI + Ollama endpoints |
| [free-ai-gateway](https://github.com/Felixdiamond/free-ai-gateway) | ~8 | zendriver | Concurrent requests |

### Useful for specific ideas

| Project | Idea |
| ------- | ---- |
| [browser-ai-bridge (jeffrey-nz)](https://github.com/jeffrey-nz/browser-ai-bridge) | 10+ sites over CDP |
| [browser-ai-bridge (chen-squared)](https://github.com/chen-squared/browser-ai-bridge) | Grok and Chinese models, OpenAI-compatible |
| [SuperGrok](https://github.com/tibberous/SuperGrok) | Single multi-model window plus a CLI |
| [browser-llm-api](https://github.com/StaticB1/browser-llm-api) | MCP, dashboard, image generation |
| [mcp-web-llm](https://github.com/HGD-coder/mcp-web-llm) | Web chat sites exposed as MCP tools |
| [chatgpt-web-mcp](https://github.com/Goudu666/chatgpt-web-mcp) | MCP server for ChatGPT only |
| [grok-web-sdk](https://github.com/ashwaniarya/grok-web-sdk) | Grok text, image and video, plus MCP |
| [LLMs2API](https://github.com/Kirazul/LLMs2API) | Multi-model gateway |
| [ai-gateway (malikasana)](https://github.com/malikasana/ai-gateway) | Minimal HTTP bridge |

## Roadmap

### Done

- [x] Sign-in in a normal browser window (avoids "This browser or app may not be secure" and
      human-check loops without any evasion); prefer the installed Chrome/Edge over bundled Chromium
- [x] Stable streaming over the OpenAI API, system prompts and multi-turn flattening
- [x] MCP server: `ask_chatgpt`, `ask_grok`, `status` (Streamable HTTP and stdio)
- [x] Ollama-compatible endpoints: `/api/chat`, `/api/generate`, `/api/tags` (+ optional port 11434)
- [x] Images and file upload (app, OpenAI `image_url`/`file` parts, Ollama `images`, MCP `files`)
- [x] Selector smoke tests (`local-ai-bridge smoke`) and a `local-ai-bridge` CLI ready for `npx`

### Next

- [ ] More providers, each with its own selector set, browser profile and ready / signed-out /
      check status: Claude (claude.ai), Gemini (gemini.google.com), DeepSeek; optionally Qwen, Kimi.
      Selectors to be verified with a signed-in account (`smoke --send --profile app`).
- [ ] Publish to npm so `npx local-ai-bridge` works without cloning
- [ ] Simple status dashboard page served by the API (providers, queue, recent errors)
- [ ] Tool / function calling emulation (tools described in the prompt, replies parsed into `tool_calls`)
- [ ] Anthropic Messages API format alongside OpenAI's

### Later / optional

- [ ] Models collaborating: one answers, another critiques
- [ ] Returning images that the sites generate
- [ ] Better installers (code signing; evaluate Tauri only if a Node sidecar becomes practical)

## Principles

- These projects, this one included, are in a grey area regarding the sites' terms of service.
  Never present the project as official or affiliated.
- Selectors break often, so updating them must stay simple: runtime overrides plus smoke tests.
- Always use persistent profiles so the user signs in once.
- Prefer the system Chrome/Edge over a bundled Chromium.
