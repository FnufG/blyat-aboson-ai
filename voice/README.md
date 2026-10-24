# Voice backend

Local FastAPI and LiveKit Agents broker for an English support assistant. The default answer provider is a cloud OpenAI-compatible LLM. English Whisper recognition and Silero VAD remain local. LlamaIndex BM25 retrieves uploaded knowledge; Boson generates speech when configured, otherwise the labelled eSpeak English test voice is used.

From the prepared project root:

```bash
npm run voice:up
npm run voice:status
```

Cloud mode starts LiveKit, FastAPI and the worker; it does not start a local language model. Native generated LiveKit credentials are in ignored `.local/runtime.env`. Service ports are internal/loopback; this broker is not a public multi-tenant API.

## Configuration

- `LLM_BACKEND=cloud` (default), `LLM_API_KEY`, `LLM_BASE_URL=https://api.openai.com/v1`, `LLM_MODEL=gpt-4.1-mini` configure the shared text/voice answer service.
- `LLM_BACKEND=local` explicitly enables a separately installed OpenAI-compatible local model, with a local URL/alias.
- `WHISPER_MODEL_PATH` selects preinstalled weights; normal setup downloads and verifies the pinned Whisper base model.
- `ESPEAK_BINARY` selects the test speech executable; speech uses English.
- `BOSON_API_KEY` enables Boson, with optional `BOSON_BASE_URL`, `BOSON_MODEL`, `BOSON_VOICE`.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` select the private RTC service. Next.js issues scoped participant tokens; browser clients never receive its administrative secret.

Only runtime `.env.local` or securely bound environment variables should contain API keys. Missing/invalid cloud credentials appear as an actionable readiness or answer error, not fabricated fallback content. Provider readiness is separate from web-container health. A configured Boson key is not proof of a verified account (`bosonVerified=false`).

## API

- `GET /health`: LLM access/model configuration, Whisper, VAD, voice provider, LiveKit and worker readiness.
- `POST /answer`: `{question, knowledge, history}` → `{answer, sources, status, mode:'llm'}`. Cloud requests use the same grounded English generation service for text and voice. Unknown questions abstain rather than inventing facts.
- `POST /sessions`: `{knowledge, companyName?, language:'en'}` → `{roomName, agentName:'liniya-support', ttsMode}`. Requires ready services and nonempty knowledge.
- `DELETE /sessions/{roomName}`: remove temporary room knowledge.

Room knowledge lives in SQLite, is isolated per room and expires after one hour. The worker greets the browser participant, uses the shared AnswerService and publishes source/error topics. LiveKit controls speech turns and interruption. The current lexical retriever and source validation still need evaluation on real business material.

## Checks

```bash
npm run voice:test
```

Backend tests cover English retrieval, validation, room isolation, provider requests/errors and speech adapters using controlled external-service fixtures. They do not establish live OpenAI/Boson access or physical microphone quality. See the root README for an explicitly enabled live text smoke test. Legacy Russian Piper/local-Qwen synthetic scripts are disabled by default and are not the English cloud acceptance check.
