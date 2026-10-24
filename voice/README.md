# Voice backend

Local FastAPI and LiveKit Agents service for English support. By default llama.cpp/Qwen2.5-1.5B generates both text and voice answers. English Whisper and Silero VAD are local. LlamaIndex BM25 retrieves uploaded company knowledge. Boson generates speech when configured; otherwise explicitly labelled English eSpeak test speech is used.

From the prepared project root:

```bash
npm run voice:setup
npm run voice:up
npm run voice:status
```

Local mode starts LiveKit, Qwen's server, FastAPI and the worker. Generated LiveKit credentials stay in ignored `.local/runtime.env`. This broker binds internally/loopback and is not a public multi-tenant API.

## Configuration

- Default `LLM_BACKEND=local`, `LLM_BASE_URL=http://127.0.0.1:11434/v1`, `LLM_MODEL=qwen2.5:1.5b`. No cloud LLM key is required or used for local generation.
- Docker pins these local settings, overriding old cloud values in `.env.local`. Native development respects explicit configuration, so update old native settings manually before setup.
- `WHISPER_MODEL_PATH` selects preinstalled recognition weights; setup verifies the pinned model.
- `ESPEAK_BINARY` selects the labelled English test voice executable.
- `BOSON_API_KEY`, with optional base/model/voice settings, enables external speech synthesis. This remains separate from the local answer model.
- LiveKit administrative credentials stay server-side; Next.js issues scoped participant tokens.

Explicit native cloud development is optional and requires `LLM_BACKEND=cloud`, HTTPS provider URL, supported model and private key. The supplied Docker distribution remains local. Do not print credential files or commit keys.

## API

- `GET /health`: local model, STT, VAD, output provider, LiveKit and worker readiness.
- `POST /answer`: `{question,knowledge,history}` → `{answer,sources,status,mode:'llm'}` for the shared English answer service.
- `POST /sessions`: `{knowledge,companyName?,language:'en'}` → room metadata; requires ready services and nonempty knowledge.
- `DELETE /sessions/{roomName}` removes temporary room knowledge.

Room knowledge is isolated in SQLite, expires after one hour and is cleaned up when sessions end. The worker uses the shared grounded answer function and publishes source/error topics. Speech recognition, answer-generation and speech-output errors use safe typed diagnostics. LiveKit handles turns and interruptions.

## Checks

Run `npm run voice:test` for backend contracts and `npm run smoke` for a short real local-model text check. The smoke fixture is private validation data and is not seeded into the UI. Automated tests do not prove physical microphone acoustics or every provider account. Legacy Russian synthetic voice diagnostics remain disabled by default and are not acceptance tests for this English version.
