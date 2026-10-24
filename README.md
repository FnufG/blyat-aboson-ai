# Liniya — local English voice support

A browser support assistant for one workspace. Upload your own company information, test answers in text, then speak through the browser. The knowledge base starts empty. The English interface, custom knowledge and recent error reporting remain in place.

**Windows:** install/start Docker Desktop and follow [LOCAL_RUN.md](LOCAL_RUN.md). Double-click `START_WINDOWS.cmd`; an OpenAI key is not needed. `CONFIGURE_KEYS_WINDOWS.cmd` is optional and configures only Boson speech.

The default pipeline is **LiveKit Agents / React → local English faster-whisper → LlamaIndex BM25 → local llama.cpp / Qwen2.5-1.5B → Boson TTS**. Without a Boson key, English eSpeak test speech is clearly labelled. Text and voice use the same grounded answer service. Local answers do not consume a cloud LLM quota. Boson is still an external paid voice service when enabled.

## Local configuration

The supplied `compose.yaml` pins the following runtime settings, overriding old cloud values in an existing `.env.local`:

```dotenv
LLM_BACKEND=local
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:1.5b
```

Saved cloud keys can remain in private `.env.local`; local inference does not use them. Existing Boson configuration is preserved. Do not commit `.env.local` or put keys in browser code. Compose loads it at runtime and excludes it from image builds.

```bash
docker compose up --build
```

First setup downloads about **1.3 GB** of verified Qwen and Whisper weights plus retrieval data. Cached files in the Docker volume are reused. Setup still checks official model metadata online; it is not a fully offline installer. TLS, APT signatures and SHA256 checks remain enabled. No GPU is required; CPU response time depends on question length and available resources. Qwen1.5B is a small model: evaluate its answers against your real support material.

The web health check measures interface availability. The voice panel separately reports model, recognition, output and RTC readiness. Wait for **Model ready** before testing local answers. A healthy web page alone does not prove conversation readiness.

## Using your information

1. Open **Knowledge base**, upload a UTF-8 `.md` / `.txt` file or choose **Add answer**.
2. Check source-backed answers in **Test chat**.
3. Open **Voice conversation**, wait for readiness, start a call and allow microphone access. Recognition, greetings and answers use English.
4. Export knowledge for backup. Knowledge and text history live in this browser. Changing knowledge ends an active voice conversation.

Markdown uses `## Question or topic` followed by a verified answer. TXT uses a title on the first line of each blank-line-separated block. Import replaces the existing knowledge. Limits: 100 entries, 200 characters per title, 4,000 per answer and 180,000 total characters. PDF/DOCX are not supported. Documents provide retrieval context; they do not fine-tune model weights.

## Native Debian development

Use Debian x86_64, Node.js22.12+, Python3.12, uv, Docker for the official pinned LiveKit binary, and signed Debian package sources.

```bash
npm ci
uv venv voice/.venv
UV_CACHE_DIR=/tmp/liniya-uv-cache uv pip sync --python voice/.venv/bin/python voice/requirements.lock
npm run voice:setup
npm run build
npm run mvp
```

For an existing native `.env.local`, select the three local settings above before setup, then restart services. Native launchers respect explicit environment configuration. Docker intentionally overrides stale cloud settings automatically.

`voice:setup` installs pinned llama.cpp/Qwen, Whisper, verified NLTK data, LiveKit and signed eSpeak. Model/resource locks and dependency lockfiles remain authoritative. Runtime data and generated LiveKit credentials stay under ignored `.local/`. Do not run development and production Next.js with the same `.next` folder concurrently.

```bash
npm run voice:up
npm run voice:status
npm run voice:down
npm run voice:web-up
```

Explicit native cloud development remains possible with `LLM_BACKEND=cloud`, an HTTPS `LLM_BASE_URL`, a compatible `LLM_MODEL` and private `LLM_API_KEY`. The supplied Docker distribution stays local; those `.env.local` cloud values do not override Compose's pinned local settings. `LLM_BACKEND=faq` is an extractive text test mode.

## Validation

```bash
npm test
npm run voice:test
npm run typecheck
npm run build
npm run test:e2e
npm run smoke
```

`smoke` uses private English fixture information and the actual running local model; it does not add data to your workspace. If explicitly pointed at a cloud-backed application, it refuses calls without `SMOKE_ALLOW_CLOUD=1`. Automated tests use controlled fixtures; real microphone acoustics and provider account behavior still require evaluation. Legacy Russian synthetic-audio diagnostics are disabled by default and are not acceptance tests for this English version.

## Scope

Ports are bound to `127.0.0.1` by default. Public access needs HTTPS, reachable WSS LiveKit and ICE/TURN; telephone routing is not configured. This is a single-workspace MVP without company accounts or billing. Voice knowledge is isolated by room in SQLite with a one-hour TTL. Source citations help review facts but do not guarantee answer correctness.
