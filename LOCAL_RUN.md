# Run Liniya on your computer

## Windows: local model

1. Start [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) with WSL2 and Linux containers. Wait for its engine to be running.
2. Extract the latest project ZIP. Node.js, Python and Git are not required on Windows.
3. Double-click **`START_WINDOWS.cmd`** and keep its window open during setup. It builds the app and prepares the local Qwen language model and English Whisper recognition. **No OpenAI key or balance is required.**
4. First setup downloads about **1.3 GB** of weights. Previously downloaded files in the same Docker volume are reused. When the web interface opens at **http://localhost:3000**, wait for **Model ready** before asking a question.
5. Open **Knowledge base → Upload file** for your `.txt` / `.md` instructions, or **Add answer**. The workspace starts empty. Check **Test chat**, then **Voice conversation**, allowing microphone access. All conversations use English.
6. Stop the app with **`STOP_WINDOWS.cmd`**. Models remain in the Docker volume for the next start.

Boson remains optional for natural speech. Existing `BOSON_API_KEY` and voice settings in `.env.local` are preserved. To add or change its key, run **`CONFIGURE_KEYS_WINDOWS.cmd`** for masked input, then restart the app. The helper does not ask for an OpenAI key. Without Boson, the app uses labelled English eSpeak test speech. Boson requests still require its own valid API account and balance.

Use an Intel/AMD x86_64 computer. Give Docker **4 CPU and at least 6 GB RAM**; 16 GB machine RAM is recommended. Leave **20 GB free disk space** for the initial build/cache. GPU is not needed. The small CPU model can take several seconds to answer. A Linux-container test does not establish physical Windows microphone behavior.

## Update an existing installation

1. Run the old **`STOP_WINDOWS.cmd`**.
2. Download the latest ZIP from the repository's `mvp-windows` branch. Replace the source files in the **same project folder**, keeping private `.env.local`.
3. Run the new **`START_WINDOWS.cmd`**. Compose explicitly selects local inference, so old `LLM_BACKEND=cloud`, cloud URLs/models or a saved OpenAI key in `.env.local` cannot keep the Windows app on cloud answers.

Do not delete the Docker volume to update. Cached Qwen/Whisper files are reused; missing files are downloaded. Custom company knowledge and text history remain in your current browser. Export important documents before clearing browser data or changing browser/profile. The demo base remains removed and is not restored by this update.

For native development, rather than Docker, set `LLM_BACKEND=local`, `LLM_BASE_URL=http://127.0.0.1:11434/v1`, and `LLM_MODEL=qwen2.5:1.5b` in the environment or `.env.local` before `voice:setup` and restart. Native launchers respect explicit settings.

## Your support information

Save text in UTF-8. A Markdown section is a `## Question or topic` followed by the actual verified answer. TXT uses a title on the first line of each block followed by an answer, separated from the next block by a blank line. Import replaces the current knowledge and clears the text conversation. Individual answers can be added or edited manually. Export a backup from the interface. PDF and DOCX are not supported.

Limits: 100 entries, 200 characters per title, 4,000 per answer and 180,000 total characters. The uploaded information is retrieved for answers; it does not retrain model weights.

## Terminal, Linux and macOS

Use Docker Compose v2.24+ and run from the project folder:

```bash
docker compose up --build
```

Wait for `Starting the browser interface` and Next.js startup, then open **http://localhost:3000** on that computer. Internet is required for the image build, missing weights and metadata checks. Local answers do not use a cloud model. Boson requires internet when enabled. TLS, signatures and checksum verification remain enabled.

The image is `linux/amd64`; Apple Silicon uses emulation rather than a native ARM build. To run in the background, inspect logs and stop:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

After changing Boson configuration in `.env.local`, recreate the container:

```bash
docker compose up -d --force-recreate
```

`docker compose down -v` removes models and local credentials; do not use it for ordinary updates or stops. By default all published ports are limited to `127.0.0.1`.

## Troubleshooting

- **Model is starting/unavailable:** run `docker compose exec liniya voice/.venv/bin/python scripts/voice-stack.py status`. On first setup wait for Qwen to download and load. Detailed logs are in `/app/.local/logs`; use `docker compose exec liniya tail -n 80 .local/logs/llm.log` for the language model.
- **Question remains without an answer:** the error is shown next to the input and the question stays marked **Not answered**. Local mode does not require OpenAI quota. Check the local model readiness/logs.
- **Speech is silent:** check the voice error message for recognition, answer generation or speech output. Boson has separate authentication/billing from the local model. Use `docker compose exec liniya tail -n 80 .local/logs/voice-worker.log` for worker diagnostics.
- **Exit137 / Killed:** increase Docker memory and close other heavy programs. If your PC has less than the recommended memory, the process may be terminated.
- **Download stalls:** inspect logs and network access to GitHub, Debian, npm, PyPI and Hugging Face/CDNs. Do not disable TLS, signatures or checksums.
- **Port conflict:** stop the previous project instance before restarting; ports3000,7880,7881 and UDP50000–50100 must be available.
- **No microphone:** open `http://localhost:3000` on the Docker computer and allow the microphone in browser/Windows settings. HTTP from another computer does not provide browser microphone access.

Public hosting, telephone routing, company accounts and billing are not configured.
