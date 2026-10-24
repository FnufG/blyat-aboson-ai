#!/usr/bin/env python3
"""Reproducible local dependencies and process lifecycle; never prints credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
PYTHON = ROOT / "voice/.venv/bin/python"
LLAMA_RELEASE = "b11669"
LLAMA_SHA = "cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac"
LIVEKIT_IMAGE = "livekit/livekit-server@sha256:89ca9ce0791e18d6e03bf6e2c49ceb27e1c754eae8bd50c989386c1a5963791a"
LLAMA = LOCAL / "bin" / f"llama-{LLAMA_RELEASE}" / "llama-server"
GGUF = LOCAL / "models/qwen2.5-1.5b-instruct-q4_k_m.gguf"


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_settings():
    from dotenv import dotenv_values
    for path in [ROOT / ".env.local", LOCAL / "runtime.env"]:
        for key, value in dotenv_values(path).items():
            if value is not None:
                os.environ.setdefault(key, value)
    os.environ.setdefault("LLM_BACKEND", "local")
    local = os.environ["LLM_BACKEND"] == "local"
    os.environ.setdefault("LLM_BASE_URL", "http://127.0.0.1:11434/v1" if local else "https://api.openai.com/v1")
    os.environ.setdefault("LLM_MODEL", "qwen2.5:1.5b" if local else "gpt-4.1-mini")


def install_binaries():
    load_settings()
    (LOCAL / "bin").mkdir(parents=True, exist_ok=True)
    if os.environ["LLM_BACKEND"] == "local" and not LLAMA.is_file():
        archive = LOCAL / f"llama-{LLAMA_RELEASE}.tar.gz"
        url = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_RELEASE}/llama-{LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz"
        urllib.request.urlretrieve(url, archive)
        if digest(archive) != LLAMA_SHA:
            archive.unlink(missing_ok=True)
            raise RuntimeError("llama.cpp checksum verification failed; installation stopped.")
        with tarfile.open(archive) as source:
            source.extractall(LOCAL / "bin", filter="data")
        archive.unlink()
    livekit = LOCAL / "bin/livekit-server"
    if not livekit.is_file():
        subprocess.run(["docker", "pull", LIVEKIT_IMAGE], check=True)
        name = "liniya-extract-" + secrets.token_hex(4)
        subprocess.run(["docker", "create", "--name", name, LIVEKIT_IMAGE], check=True, stdout=subprocess.DEVNULL)
        try:
            subprocess.run(["docker", "cp", name + ":/livekit-server", str(livekit)], check=True)
            livekit.chmod(0o755)
        finally:
            subprocess.run(["docker", "rm", name], check=True, stdout=subprocess.DEVNULL)
    configured_espeak = os.environ.get("ESPEAK_BINARY")
    if configured_espeak:
        binary = shutil.which(configured_espeak) or configured_espeak
        if not os.path.isfile(binary) or not os.access(binary, os.X_OK):
            raise RuntimeError("Configured ESPEAK_BINARY is not executable.")
        subprocess.run([binary, "--version"], check=True, stdout=subprocess.DEVNULL)
    else:
        subprocess.run(["bash", str(ROOT / "scripts/install-espeak.sh")], check=True)



def install_nltk_data():
    import zipfile
    resources = json.loads((ROOT / "voice/nltk-lock.json").read_text())
    cache = LOCAL / "nltk-archives"
    cache.mkdir(parents=True, exist_ok=True)
    for name, resource in resources.items():
        subdir = resource.get("subdir", "tokenizers")
        if subdir not in {"tokenizers", "corpora"}:
            raise RuntimeError("Unexpected official NLTK resource directory.")
        data = LOCAL / "nltk_data" / subdir
        data.mkdir(parents=True, exist_ok=True)
        target = data / name
        marker = target / ".liniya-verified-sha256"
        if marker.is_file() and marker.read_text().strip() == resource["sha256"]:
            continue
        archive = cache / (name + ".zip")
        if not archive.is_file() or digest(archive) != resource["sha256"]:
            urllib.request.urlretrieve(resource["url"], archive)
        if digest(archive) != resource["sha256"]:
            raise RuntimeError("Official NLTK data checksum mismatch; installation stopped.")
        if target.exists() and any(target.iterdir()) and not marker.exists():
            raise RuntimeError("Unmanaged NLTK data exists; refusing to overwrite it.")
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                path = Path(item.filename)
                if path.is_absolute() or ".." in path.parts or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise RuntimeError("Unsafe entry in official NLTK archive.")
            source.extractall(data)
        marker.write_text(resource["sha256"] + "\n")
    print("Verified NLTK tokenizer resources installed for offline RAG startup.")


def install_models():
    load_settings()
    install_nltk_data()
    if os.environ["LLM_BACKEND"] == "local":
        print("Preparing verified local models: Qwen about 1.1 GB and English Whisper about 150 MB. Previously downloaded weights are reused.", flush=True)
    else:
        print("Preparing English Whisper speech recognition, about 150 MB. Explicit cloud mode skips Qwen.", flush=True)
    os.environ.setdefault("HF_HOME", str(LOCAL / "huggingface"))
    os.environ.setdefault("HF_XET_CACHE", str(LOCAL / "huggingface/xet"))
    os.environ.setdefault("XDG_CACHE_HOME", str(LOCAL / "cache"))
    # Use Hugging Face's supported HTTPS downloader. Native Xet retries can hide
    # a blocked CDN route for minutes; SHA256 verification below stays required.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from huggingface_hub import HfApi, hf_hub_download, snapshot_download, get_hf_file_metadata, hf_hub_url
    import requests
    from urllib.parse import urlparse

    def require_artifact_route(repo, filename, revision):
        metadata = get_hf_file_metadata(hf_hub_url(repo, filename, revision=revision), token=False, timeout=15)
        hostname = urlparse(metadata.location).hostname
        try:
            with requests.get(metadata.location, headers={"Range": "bytes=0-0"}, stream=True, timeout=(10, 20)) as response:
                if response.status_code not in (200, 206):
                    raise RuntimeError(f"Official model download host {hostname} returned HTTP {response.status_code}. Apply its saved network permission and retry.")
                next(response.iter_content(1), b"")
        except requests.RequestException as error:
            # Never print signed artifact URLs or proxy credentials from exceptions.
            reason = "HTTP 403" if "403" in str(error) else type(error).__name__
            raise RuntimeError(f"Official model download host {hostname} is unavailable ({reason}). Apply its saved network permission and retry.") from None
    api = HfApi(token=False)
    model_dir = LOCAL / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = model_dir / "manifest.json"
    lock_path = ROOT / "voice/model-lock.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else (json.loads(lock_path.read_text()) if lock_path.is_file() else {})
    if os.environ["LLM_BACKEND"] == "local":
        qwen_repo = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
        info = api.model_info(qwen_repo, revision=manifest.get("qwen", {}).get("revision", "main"), files_metadata=True)
        filename = GGUF.name
        entry = next((item for item in info.siblings if item.rfilename == filename), None)
        expected = entry.lfs.sha256 if entry and entry.lfs else None
        if not expected:
            raise RuntimeError("Official model metadata does not contain a SHA256 for the selected Qwen GGUF.")
        pinned_checksum = manifest.get("qwen", {}).get("sha256")
        if pinned_checksum and pinned_checksum != expected:
            raise RuntimeError("Official Qwen metadata disagrees with the pinned checksum; installation stopped.")
        if not GGUF.is_file() or digest(GGUF) != expected:
            require_artifact_route(qwen_repo, filename, info.sha)
            path = hf_hub_download(qwen_repo, filename, revision=info.sha, local_dir=model_dir, token=False, force_download=GGUF.is_file())
            if digest(path) != expected:
                raise RuntimeError("Qwen artifact checksum mismatch. Do not use it.")
        manifest["qwen"] = {"repo": qwen_repo, "revision": info.sha, "file": filename, "sha256": expected}
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    # Whisper artifacts are tied to an exact repository revision; LFS files are verified below.
    whisper_repo = "Systran/faster-whisper-base"
    info = api.model_info(whisper_repo, revision=manifest.get("whisper", {}).get("revision", "main"), files_metadata=True)
    if not (model_dir / "whisper-base/model.bin").is_file():
        require_artifact_route(whisper_repo, "model.bin", info.sha)
    patterns = ["model.bin", "config.json", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"]
    location = Path(snapshot_download(whisper_repo, revision=info.sha, allow_patterns=patterns, local_dir=model_dir / "whisper-base", token=False))
    hashes = {}
    for entry in info.siblings:
        path = location / entry.rfilename
        if path.is_file() and entry.lfs:
            expected = entry.lfs.sha256
            pinned_checksum = manifest.get("whisper", {}).get("sha256", {}).get(entry.rfilename)
            if pinned_checksum and pinned_checksum != expected:
                raise RuntimeError("Official Whisper metadata disagrees with the pinned checksum; installation stopped.")
            if digest(path) != expected:
                raise RuntimeError("Whisper artifact checksum mismatch. Do not use it.")
            hashes[entry.rfilename] = expected
    if "model.bin" not in hashes:
        raise RuntimeError("Whisper weights were not verified.")
    manifest["whisper"] = {"repo": whisper_repo, "revision": info.sha, "sha256": hashes}
    # The CC0 Piper voice creates natural synthetic input for end-to-end tests.
    # Application output remains the explicitly labelled eSpeak/Boson provider.
    locked = json.loads(lock_path.read_text()) if lock_path.is_file() else {}
    piper = locked.get("piper")
    if piper and os.environ.get("VOICE_INSTALL_TEST_FIXTURES") == "1":
        directory = model_dir / "piper-test"
        directory.mkdir(exist_ok=True)
        for name, artifact in piper["files"].items():
            destination = directory / name
            if destination.is_file() and digest(destination) == artifact["sha256"]:
                continue
            require_artifact_route(piper["repo"], artifact["file"], piper["revision"])
            downloaded = Path(hf_hub_download(piper["repo"], artifact["file"], revision=piper["revision"], cache_dir=LOCAL / "huggingface/hub", token=False))
            if digest(downloaded) != artifact["sha256"]:
                raise RuntimeError("Piper artifact checksum mismatch; do not use this file.")
            pending = destination.with_suffix(destination.suffix + ".partial")
            shutil.copyfile(downloaded, pending)
            os.replace(pending, destination)
        (directory / "manifest.json").write_text(json.dumps(piper, indent=2) + "\n")
        manifest["piper"] = piper
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print("Official model artifacts downloaded and verified; revisions retained in .local/models/manifest.json.")


def configure():
    LOCAL.mkdir(exist_ok=True)
    runtime = LOCAL / "runtime.env"
    if not runtime.is_file():
        # Legitimate local server credentials, generated here rather than external account credentials.
        runtime.write_text("LIVEKIT_API_KEY=liniya-" + secrets.token_hex(8) + "\nLIVEKIT_API_SECRET=" + secrets.token_hex(32) + "\n")
        runtime.chmod(0o600)
    load_settings()
    defaults = {
        "LIVEKIT_URL": "ws://127.0.0.1:7880",
        "VOICE_API_URL": "http://127.0.0.1:8001",
        "WHISPER_MODEL_PATH": str(LOCAL / "models/whisper-base"),
        "ESPEAK_BINARY": str(LOCAL / "espeak/bin/espeak-ng"),
        "NLTK_DATA": str(LOCAL / "nltk_data"),
        "HF_HOME": str(LOCAL / "huggingface"), "HF_HUB_OFFLINE": "1",
        "NO_PROXY": "localhost,127.0.0.1,::1",
    }
    for key, value in defaults.items():
        os.environ.setdefault(key, value)
    config = LOCAL / "livekit.yaml"
    bind = os.environ.get("LIVEKIT_BIND_ADDRESS", "127.0.0.1")
    rtc_config = {"tcp_port": 7881, "port_range_start": 50000, "port_range_end": 50100, "use_external_ip": False}
    advertised = os.environ.get("LIVEKIT_NODE_IP")
    if bind in {"127.0.0.1", "::1"}:
        # Local browsers must receive candidates matching the loopback listener.
        # Advertising an auto-detected private address breaks browser ICE here.
        rtc_config["node_ip"] = advertised or bind
        rtc_config["enable_loopback_candidate"] = True
    elif advertised:
        rtc_config["node_ip"] = advertised
        if advertised in {"127.0.0.1", "::1"}:
            rtc_config["enable_loopback_candidate"] = True
    config.write_text(json.dumps({"port": 7880, "bind_addresses": [bind], "rtc": rtc_config, "keys": {os.environ["LIVEKIT_API_KEY"]: os.environ["LIVEKIT_API_SECRET"]}}))
    config.chmod(0o600)
    return config


def pids_dir():
    directory = LOCAL / "pids"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def running(name):
    path = pids_dir() / (name + ".json")
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    try:
        cmdline = Path(f"/proc/{data['pid']}/cmdline").read_bytes().replace(b"\x00", b" ").decode()
        if all(part in cmdline for part in data["identity"]):
            os.kill(data["pid"], 0)
            return data["pid"]
    except (OSError, ValueError):
        pass
    return None


def start(name, command, identity):
    if running(name):
        print(name + ": already started by this project.")
        return
    log_dir = LOCAL / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    child_env = os.environ.copy()
    from urllib.parse import urlparse
    endpoint = urlparse(child_env.get("LIVEKIT_URL", "ws://127.0.0.1:7880"))
    if name == "voice-worker" and endpoint.scheme == "ws" and endpoint.hostname in {"localhost", "127.0.0.1", "::1"}:
        # Native LiveKit WS ignores NO_PROXY. Only the loopback WS route is direct;
        # HTTPS_PROXY remains intact for external HTTPS services such as Boson.
        child_env["HTTP_PROXY"] = ""
        child_env["http_proxy"] = ""
    with (log_dir / (name + ".log")).open("ab") as log:
        proc = subprocess.Popen(command, cwd=ROOT, env=child_env, stdout=log, stderr=log, start_new_session=True)
    (pids_dir() / (name + ".json")).write_text(json.dumps({"pid": proc.pid, "identity": identity}))
    time.sleep(0.3)
    if proc.poll() is not None:
        raise RuntimeError(name + " exited. See .local/logs/" + name + ".log")
    print(name + ": started.")


def up():
    config = configure()
    if not (LOCAL / "bin/livekit-server").exists():
        raise RuntimeError("Run npm run voice:setup first.")
    start("livekit", [str(LOCAL / "bin/livekit-server"), "--config", str(config)], [str(LOCAL / "bin/livekit-server")])
    if os.environ["LLM_BACKEND"] == "local" and GGUF.is_file():
        start("llm", [str(LLAMA), "--model", str(GGUF), "--alias", os.environ["LLM_MODEL"], "--host", "127.0.0.1", "--port", "11434", "--threads", "3", "--ctx-size", "8192", "--n-predict", "256", "--parallel", "1"], [str(LLAMA), str(GGUF)])
    elif os.environ["LLM_BACKEND"] == "local":
        print("LLM weights absent: download required, not ready for conversation.")
    else:
        print("Cloud LLM selected; no local language model is started.")
    start("voice-api", [str(PYTHON), "-m", "uvicorn", "voice.api:app", "--host", "127.0.0.1", "--port", "8001"], ["uvicorn", "voice.api:app"])
    import http.client
    for attempt in range(30):
        connection = http.client.HTTPConnection("127.0.0.1", 8001, timeout=5)
        try:
            connection.request("GET", "/health")
            response = connection.getresponse()
            response.read()
            if response.status == 200:
                break
        except OSError:
            time.sleep(0.5)
        finally:
            connection.close()
    else:
        raise RuntimeError("Voice API did not become available; inspect .local/logs/voice-api.log")
    if (LOCAL / "models/whisper-base/model.bin").is_file():
        start("voice-worker", [str(PYTHON), "-m", "voice.worker", "start"], ["voice.worker", "start"])
    else:
        print("STT weights absent: agent worker not started.")


def down():
    for name in ["web", "voice-worker", "voice-api", "llm", "livekit"]:
        pid = running(name)
        if pid:
            os.killpg(pid, signal.SIGTERM)
            print(name + ": stopped.")
        (pids_dir() / (name + ".json")).unlink(missing_ok=True)


def check():
    import httpx
    response = httpx.get("http://127.0.0.1:8001/health", timeout=20)
    response.raise_for_status()
    status = response.json()
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0 if status["ready"] else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup", "models", "up", "down", "status", "web", "web-up"])
    args = parser.parse_args()
    if args.command == "setup":
        install_binaries()
        install_models()
    elif args.command == "models":
        install_models()
    elif args.command == "up":
        up()
    elif args.command == "down":
        down()
    elif args.command == "status":
        return check()
    elif args.command == "web-up":
        configure()
        start("web", ["npm", "run", "start"], ["npm", "run", "start"])
    elif args.command == "web":
        configure()
        os.execvpe("npm", ["npm", "run", "start"], os.environ)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Avoid arbitrary HTTP exception strings: proxy URLs may carry credentials.
        print("Voice setup stopped: " + (str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__) + ". See README for requirements.", file=sys.stderr)
        sys.exit(1)
