# Run Liniya on your computer

## Windows

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/), using WSL 2 and Linux containers. Start Docker Desktop and wait for its engine to be running.
2. Extract the project ZIP into a folder. Node.js, Python and Git are not required on Windows.
3. Double-click **`CONFIGURE_KEYS_WINDOWS.cmd`**. Paste your OpenAI key into the masked prompt and press Enter. The helper saves it in private `.env.local` and selects cloud mode; it never prints the value or puts it in a command argument. Blank input keeps a previously saved key.
4. At the optional Boson prompt, paste your Boson key or press Enter to skip/keep the saved key. Without it the app uses an explicitly labelled English eSpeak test voice. OpenAI supplies answers; Boson supplies speech, so they use separate keys.
5. Double-click **`START_WINDOWS.cmd`**. If the OpenAI key is missing, it opens the same masked setup helper automatically. Keep its window open during preparation. The first build installs dependencies and downloads approximately 150 MB of Whisper speech-recognition weights plus retrieval data. Cloud mode does not download or start Qwen.
6. When the web interface is available, the script opens **http://localhost:3000** on your computer. Open **Knowledge base → Upload file** and choose your own `.txt` or `.md` instructions, or use **Add answer**. The knowledge base starts empty.
7. Test your material in **Test chat**, then open **Voice conversation**, start a call and allow microphone access. All conversations use English. Headphones help reduce echo.
8. To stop the app, double-click **`STOP_WINDOWS.cmd`**. Downloaded files remain in the Docker volume.

The web interface can open while the cloud key is missing or the voice service is unavailable, so you can still edit your knowledge base. The voice panel reports the components that need attention. A running container or healthy web page does not prove that the OpenAI/Boson account is ready.

Use an Intel/AMD x86_64 computer. Give Docker at least **4 CPU and 6 GB RAM**; 16 GB machine RAM is recommended. Leave **20 GB free disk space** for the initial image build and cache. No GPU is needed. Runtime model storage is much smaller than the previous local-Qwen version, but building the Python and Node dependencies still needs disk space.

## Updating an existing Windows installation

Run `STOP_WINDOWS.cmd` first. Download the latest ZIP from the repository's `mvp-windows` branch and replace the source files in your existing project folder, preserving private `.env.local`. Run `CONFIGURE_KEYS_WINDOWS.cmd` to set the cloud key, then `START_WINDOWS.cmd` to rebuild. Your Docker volume is retained. Old Qwen weights may remain in it, but cloud mode neither loads nor starts them. Do not delete the volume to upgrade.

Existing custom knowledge is retained by the browser migration. The old bundled fictional FAQ is removed. Export important knowledge before clearing browser data or switching browser/profile.

For manual setup, copy `.env.example` to `.env.local`, enter `LLM_API_KEY` and optional `BOSON_API_KEY`, and keep the cloud defaults. Save the exact filename `.env.local`, not `.env.local.txt`. The masked helper uses standard Windows PowerShell commands; it does not change execution policy.

## Your support information

Save files in UTF-8. Markdown uses a heading for each question/topic followed by the verified answer:

```markdown
## What are your support hours?
Enter your company's actual support hours here.

## How can customers contact support?
Enter the verified support contact details here.
```

For `.txt`, each block starts with a question/title and its following lines contain the answer; separate blocks with blank lines. Import replaces the current knowledge base and clears the text conversation. You can also add and edit individual answers. PDF and DOCX are not supported. Limits: 100 entries, 200 characters per title, 4,000 per answer and 180,000 characters overall. Export a backup from the interface; permanent knowledge and text history currently live in this browser.

## Terminal, Linux and macOS

Use Docker Compose v2.24+ (included in current Docker Desktop). Configure `.env.local` as above, then from the project folder run:

```bash
docker compose up --build
```

Wait for `Starting the browser interface` and Next.js startup, then open **http://localhost:3000** on the same computer. Internet is needed for building, initial model downloads, cloud answers and Boson. Cached Whisper weights are reused, but setup still checks official Hugging Face metadata online. TLS, APT signatures and SHA256 checks remain enabled.

The image is `linux/amd64`; Apple Silicon uses emulation and is not a native ARM build. A Linux-container check does not establish physical Windows/macOS microphone compatibility. The former Russian local-LLM end-to-end reports do not validate the new English cloud configuration.

To run in the background, inspect logs and stop:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

After changing `.env.local`, recreate the container:

```bash
docker compose up -d --force-recreate
```

`docker compose down -v` deletes downloaded files and local server credentials; do not use it for an ordinary stop or update.

## Troubleshooting

- **The web interface opens but answers are unavailable:** check `LLM_API_KEY` in `.env.local`, your provider's billing/model permissions and the error shown in Test chat or Voice conversation. Recreate the container after editing the file. Keys are never sent to the browser. The question and retrieved knowledge excerpts are sent to the configured cloud LLM; spoken answer text is sent to Boson when enabled.
- **`port is already allocated`:** free ports 3000, 7880, 7881 and UDP 50000–50100. Compose publishes them only on `127.0.0.1`.
- **Exit 137 / `Killed`:** increase Docker's available memory and close other heavy programs.
- **Model download stalls:** inspect `docker compose logs -f`; allow access to GitHub, Debian, npm, PyPI, Hugging Face and its CDN. Do not disable certificate or checksum verification.
- **No microphone:** use `http://localhost:3000` on the Docker computer and allow microphone access in the browser and Windows settings. HTTP from another computer does not provide a browser microphone.
- **Voice service not ready:** run `docker compose exec liniya voice/.venv/bin/python scripts/voice-stack.py status`. For worker logs use `docker compose exec liniya tail -n 80 .local/logs/voice-worker.log`.

This is a local single-workspace MVP. Public hosting, telephone numbers, accounts and billing are not configured.
