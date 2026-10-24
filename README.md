# Liniya — English voice support over your knowledge base

A browser support assistant for one workspace. Upload your own support information, test answers in text, then speak through the browser. The knowledge base starts empty; no fictional company data or suggested demo questions are seeded.

**Windows:** follow [LOCAL_RUN.md](LOCAL_RUN.md), run `CONFIGURE_KEYS_WINDOWS.cmd` for masked key entry, then `START_WINDOWS.cmd`. Docker Desktop must be running. Node.js and Python do not need to be installed on Windows.

The default pipeline is **LiveKit Agents / React → faster-whisper (English) → LlamaIndex BM25 → OpenAI-compatible cloud LLM → Boson TTS**. Without a Boson key, English eSpeak test speech is clearly labelled. OpenAI and Boson use separate keys. Cloud mode does not download or run Qwen/llama.cpp; local speech recognition still runs on your computer.

## Cloud configuration

Copy `.env.example` to ignored `.env.local` and fill in:

```dotenv
LLM_BACKEND=cloud
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1-mini
LLM_API_KEY=YOUR_PRIVATE_KEY
BOSON_API_KEY=
```

Never commit keys or put them in browser code. Compose loads the file only at runtime; it is excluded from the image build context. A compatible provider/model may be configured through `LLM_BASE_URL` and `LLM_MODEL`, but it must support the structured response contract. Changing provider settings requires a service restart. The question and selected knowledge excerpts are sent to the cloud LLM. With Boson enabled, answer text is sent for speech synthesis.

```bash
docker compose up --build
```

First startup downloads approximately 150 MB of pinned Whisper weights and verified retrieval resources. It needs internet, and cached setup still checks official model metadata online. All TLS/signature/SHA256 checks stay enabled. The web health check measures web availability; the Voice conversation panel separately reports model, recognition, voice and RTC readiness. A missing cloud key does not prevent editing knowledge.

## Using the app

1. Open **Knowledge base**, upload your own UTF-8 `.md` / `.txt` file or choose **Add answer**.
2. Check source-backed answers in **Test chat**.
3. Open **Voice conversation**, wait for service readiness, start the conversation and allow microphone access. Speech recognition, greetings and answers use English.
4. Export your knowledge for backup. The current prototype stores it and text history in this browser. Editing knowledge ends an active voice conversation.

Markdown uses `## Question or topic` followed by its answer. TXT uses a title as the first line of each blank-line-separated block. Import replaces the current knowledge base. Limits: 100 entries, titles of 200 characters, answers of 4,000 characters and 180,000 total characters. PDF/DOCX are not yet supported. Uploaded material is retrieved as reference information; it does not fine-tune model weights.

## Native Debian development

Supported setup: Debian x86_64, Node.js 22.12+, Python 3.12, uv, Docker for obtaining the pinned LiveKit binary, and APT with the Debian archive keyring.

```bash
npm ci
uv venv voice/.venv
UV_CACHE_DIR=/tmp/liniya-uv-cache uv pip sync --python voice/.venv/bin/python voice/requirements.lock
npm run voice:setup
npm run build
npm run mvp
```

`voice:setup` installs verified NLTK resources, Whisper, LiveKit and eSpeak. Cloud mode skips the llama.cpp binary, Qwen and legacy Piper test fixtures. Model revisions/checksums are pinned in `voice/model-lock.json`; retrieval resources are pinned in `voice/nltk-lock.json`. Dependencies use `package-lock.json` and `voice/requirements.lock`. Runtime files, logs and model weights live under ignored `.local/`; locally generated LiveKit credentials are restricted to their owner.

```bash
npm run voice:up
npm run voice:status
npm run voice:down
npm run voice:web-up
```

Use `npm run dev` after `voice:up` while editing. Do not run development and production Next.js with the same `.next` directory concurrently.

Local Qwen is an explicit development option: set `LLM_BACKEND=local`, `LLM_BASE_URL=http://127.0.0.1:11434/v1` and `LLM_MODEL=qwen2.5:1.5b`, then run `voice:setup` to download it. `LLM_BACKEND=faq` is an extractive text test mode, not a cloud conversation.

## Validation

```bash
npm test
npm run voice:test
npm run typecheck
npm run build
npm run test:e2e
```

Unit and browser tests use controlled fixtures; they do not establish provider billing, physical microphone acoustics or real Boson behavior. For an explicitly authorized live cloud text check, start the app with your private key and run `SMOKE_ALLOW_CLOUD=1 npm run smoke` on Linux/macOS (PowerShell: `$env:SMOKE_ALLOW_CLOUD="1"; npm run smoke`). This sends short English test questions to the configured provider and may incur API charges; the fixtures are not added to your knowledge base.

The old `scripts/*voice*check*` synthetic-audio scripts are retained as legacy local diagnostics, disabled by default and not evidence for the English cloud release. Their former Russian Piper/local-Qwen results must not be reported as validation of this configuration. Evaluate English calls with your own microphone, actual company material, provider account and chosen voice before relying on it.

## Deployment and scope

Default Docker ports are bound to `127.0.0.1`. Another computer needs HTTPS for the web app, reachable WSS for LiveKit and correct ICE/TURN configuration. Public hosting and telephone routing are not deployed.

This is a single-workspace MVP without customer accounts, billing or durable multi-tenant server storage. Voice knowledge is isolated by room in local SQLite with a one-hour TTL. Sources help review an answer but do not guarantee factual correctness; evaluate retrieval and answers on your own support material. Model/framework/provider licenses and commercial Boson terms must be checked for the intended use.
