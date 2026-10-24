# What Liniya contains

Liniya is an English browser-based support assistant for one workspace. It starts with an empty knowledge base and uses your uploaded information for answers. Source files are in the `FnufG/blyat-aboson-ai` repository; a public hosted application has not been deployed.

## Available functions

- **Knowledge base:** import UTF-8 TXT/Markdown, add/edit/delete entries and export a backup.
- **Test chat:** English answers with supporting sources from your material.
- **Voice conversation:** browser microphone, English recognition, cloud answers, speech playback, transcripts and disconnect/mute controls.
- **Cloud LLM:** OpenAI-compatible answer generation; `LLM_API_KEY` stays on the server.
- **Speech:** local Whisper recognition; Boson output when configured, otherwise labelled English eSpeak test speech.

This is not yet a multi-company SaaS: registration, subscriptions and durable company accounts are not implemented. Knowledge and text history live in the current browser; temporary voice-room knowledge is isolated in local SQLite.

## Files

```text
app/               Next.js pages, styles and HTTP routes
components/        LiveKit browser voice panel
lib/               knowledge validation, retrieval and service adapters
voice/             Python API, LiveKit worker, STT/TTS and cloud answers
voice/tests/       backend tests
scripts/           dependency setup, process lifecycle and diagnostics
tests/             application and browser tests
Dockerfile         reproducible local container build
compose.yaml       local service launch
CONFIGURE_KEYS_WINDOWS.cmd  masked API-key setup
START_WINDOWS.cmd  Windows startup
STOP_WINDOWS.cmd   Windows stop
LOCAL_RUN.md       local setup and cloud key instructions
.env.example       settings template containing no real credentials
```

`.local/`, `node_modules/`, `voice/.venv/` and `.next/` are runtime/dependency folders and are not source distribution contents. API keys are not distributed with the project.

## Open the interface

Use [LOCAL_RUN.md](LOCAL_RUN.md): install/start Docker Desktop, run `CONFIGURE_KEYS_WINDOWS.cmd` to enter your private OpenAI key, then double-click `START_WINDOWS.cmd`. After preparation the script opens http://localhost:3000 on your computer. Physical Windows microphone and provider-account behavior still need evaluation on your machine.

Open **Knowledge base → Upload file** for `.txt` or `.md`, or choose **Add answer**. Markdown sections use `## Question` followed by the answer. Import replaces the current knowledge and clears the text conversation. Test the material in text before starting a new voice conversation.

For a prepared native cloud workspace, restart with:

```bash
npm run voice:up
npm run voice:web-up
npm run voice:status
```

These commands run inside that workspace; its internal localhost address is not a public site URL.
