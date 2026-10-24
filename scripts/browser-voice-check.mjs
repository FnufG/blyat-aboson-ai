#!/usr/bin/env node
/**
 * Real browser -> LiveKit -> voice worker smoke check with synthetic speech input.
 * No routes, STT, LLM, RTC, or TTS responses are mocked. The microphone fixture is
 * real Piper Denis audio fed to Chromium's fake capture device, not a physical
 * microphone or a human recording. The worker's local test TTS remains eSpeak.
 *
 * Prerequisites: production web server on :3000, healthy local voice stack, and
 * the pinned Piper test voice installed by npm run voice:models.
 * VOICE_CHECK_AUDIO optionally supplies an existing real WAV instead.
 * Run: node scripts/browser-voice-check.mjs
 * Exit 2: prerequisite unavailable; exit 1: attempted check failed.
 */
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.VOICE_CHECK_WEB_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const python = process.env.VOICE_CHECK_PYTHON || process.env.PYTHON_BINARY || join(projectRoot, 'voice', '.venv', 'bin', 'python');
const requestedTimeout = Number(process.env.VOICE_CHECK_TIMEOUT || '150');
const timeout = Number.isFinite(requestedTimeout) ? Math.max(30_000, requestedTimeout * 1000) : 150_000;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');

async function measureRemotePcm(page) {
  // Measure real remote PCM without replacing capture, tracks, or playback.
  return page.evaluate(async () => {
    const audio = [...document.querySelectorAll('audio')].find((element) => element.srcObject instanceof MediaStream && !element.paused);
    if (!audio) throw new Error('RemoteAudioUnavailable');
    const context = new AudioContext();
    const source = context.createMediaStreamSource(audio.srcObject);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    try {
      await context.resume();
      return await new Promise((resolve, reject) => {
        const deadline = Date.now() + 30_000;
        const timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
          if (peak > 0.001) { window.clearInterval(timer); resolve(peak); }
          else if (Date.now() > deadline) { window.clearInterval(timer); reject(new Error('RemoteAudioSilent')); }
        }, 20);
      });
    } finally { source.disconnect(); await context.close(); }
  });
}

async function main() {
  let status;
  try {
    const response = await fetch(`${baseUrl}/api/voice/status`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('Voice readiness endpoint is unavailable');
    status = await response.json();
  } catch {
    emit({ check: 'browser_voice', outcome: 'blocked', reason: 'Production web or voice readiness endpoint is unavailable' });
    process.exitCode = 2;
    return;
  }
  if (status.ready !== true) {
    emit({ check: 'browser_voice', outcome: 'blocked', reason: 'Voice stack is not ready; no browser session was started', missing: Array.isArray(status.missing) ? status.missing : [] });
    process.exitCode = 2;
    return;
  }
  if (status.ttsProvider !== 'test') {
    emit({ check: 'browser_voice', outcome: 'blocked', reason: 'This check only uses the local test voice; Boson is not called' });
    process.exitCode = 2;
    return;
  }
  if (process.env.VOICE_CHECK_AUDIO && !existsSync(resolve(process.env.VOICE_CHECK_AUDIO))) {
    emit({ check: 'browser_voice', outcome: 'blocked', reason: 'VOICE_CHECK_AUDIO must point to an existing real WAV fixture' });
    process.exitCode = 2;
    return;
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), 'liniya-browser-voice-'));
  const fixture = process.env.VOICE_CHECK_AUDIO ? resolve(process.env.VOICE_CHECK_AUDIO) : join(tempDirectory, 'piper-denis-input.wav');
  const inputSource = process.env.VOICE_CHECK_AUDIO ? 'provided real WAV' : 'Piper ru_RU-denis-medium CC0 (SHA-256 verified by voice.test_speech)';
  const paddedAudio = join(tempDirectory, 'microphone.wav');
  let browser;
  let page;
  let connected = false;
  let disconnected = false;
  let audioPlayback = false;
  let userTranscribed = false;
  let citedAnswer = false;
  let guaranteePreserved = false;
  let microphoneMuted = false;
  let tracksReleased = false;
  let capturedTrackCount = 0;
  let remoteAudioPeak = 0;
  let answerAudioPeak = 0;
  let stage = 'prepare_piper_audio';
  const errors = [];
  const consoleDiagnostics = [];
  const sessionHttpStatuses = [];
  let websocketCount = 0;
  let websocketErrors = 0;
  const started = Date.now();
  try {
    if (!process.env.VOICE_CHECK_AUDIO) {
      execFileSync(python, ['-m', 'voice.test_speech', '--text', 'Какие условия гарантии?', '--output', fixture], { cwd: projectRoot, stdio: 'pipe', timeout: 60_000 });
    }
    // Silence lets the real worker join and finish its greeting before the question.
    // Chromium's %noloop suffix prevents repeated questions from interrupting replies.
    stage = 'prepare_capture_wav';
    execFileSync(python, ['-c', [
      'import sys, wave',
      'with wave.open(sys.argv[1], "rb") as audio:',
      ' params = audio.getparams()',
      ' pcm = audio.readframes(audio.getnframes())',
      ' assert params.nchannels == 1 and params.sampwidth == 2 and params.comptype == "NONE", "Expected mono PCM16 input"',
      'with wave.open(sys.argv[2], "wb") as audio:',
      ' audio.setparams(params)',
      ' audio.writeframes(bytes(params.framerate * params.nchannels * params.sampwidth * 15) + pcm + bytes(params.framerate * params.nchannels * params.sampwidth * 8))',
    ].join('\n'), fixture, paddedAudio], { stdio: 'pipe', timeout: 10_000 });

    stage = 'launch_chromium';
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${paddedAudio}%noloop`],
    });
    const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    // Observe genuine browser capture tracks; do not replace capture or audio data.
    await page.addInitScript(() => {
      window.__liniyaCapturedTracks = [];
      window.__liniyaPeerConnections = [];
      const NativePeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(NativePeerConnection, {
        construct(target, args) {
          const connection = Reflect.construct(target, args);
          const observation = { states: [], candidate_errors: [], remote_candidates: [] };
          window.__liniyaPeerConnections.push(observation);
          const addressScope = (address) => /^(127\.|::1$)/.test(address) ? 'loopback' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 'private' : address.endsWith('.local') ? 'mdns' : 'other';
          const observe = () => {
            observation.states.push({ connection: connection.connectionState, ice: connection.iceConnectionState, signaling: connection.signalingState });
            observation.remote_candidates = (connection.remoteDescription?.sdp || '').split('\n').filter((line) => line.startsWith('a=candidate:')).map((line) => {
              const fields = line.trim().split(/\s+/);
              return { protocol: fields[2], address_scope: addressScope(fields[4] || ''), port: Number(fields[5]), type: fields[7] };
            });
          };
          connection.addEventListener('connectionstatechange', observe);
          connection.addEventListener('iceconnectionstatechange', observe);
          connection.addEventListener('icecandidateerror', (event) => observation.candidate_errors.push(event.errorCode));
          observe();
          return connection;
        },
      });
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) return;
      const originalCapture = media.getUserMedia.bind(media);
      media.getUserMedia = async (...args) => {
        const stream = await originalCapture(...args);
        window.__liniyaCapturedTracks.push(...stream.getAudioTracks());
        return stream;
      };
    });
    page.on('pageerror', (error) => errors.push(error.name));
    page.on('console', async (message) => {
      if (!['error', 'warning'].includes(message.type())) return;
      const markers = ['could not establish pc connection', 'could not establish signal connection', 'could not establish subscriber connection', 'could not establish publisher connection', 'permission denied', 'failed to publish', 'notallowederror', 'invalidaccesserror', 'invalidstateerror', 'operationerror', 'connectionerror', 'websocket', 'ice failed'];
      const text = message.text().toLowerCase();
      const matched = markers.filter((marker) => text.includes(marker));
      const errorCodes = [];
      for (const argument of message.args()) {
        const details = await argument.evaluate((value) => value instanceof Error ? { code: typeof value.code === 'number' ? value.code : undefined, reason: typeof value.reason === 'number' ? value.reason : undefined } : undefined).catch(() => undefined);
        if (details) errorCodes.push(details);
      }
      if (matched.length || errorCodes.length) consoleDiagnostics.push({ type: message.type(), markers: matched, error_codes: errorCodes });
    });
    page.on('response', (response) => { if (new URL(response.url()).pathname === '/api/voice/session') sessionHttpStatuses.push(response.status()); });
    page.on('websocket', (socket) => { websocketCount += 1; socket.on('socketerror', () => { websocketErrors += 1; }); });
    stage = 'open_production_ui';
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.getByRole('button', { name: 'Голосовой диалог', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Начать голосовой разговор', exact: true })).toBeEnabled({ timeout: 15_000 });
    stage = 'connect_livekit';
    await page.getByRole('button', { name: 'Начать голосовой разговор', exact: true }).click();
    await expect(page.locator('.voice-connection-details')).toContainText('Канал: подключён', { timeout: 30_000 });
    connected = true;
    await expect(page.getByRole('button', { name: 'Выключить микрофон', exact: true })).toBeVisible();

    const startAudio = page.getByRole('button', { name: 'Включить звук ответов', exact: true });
    if (await startAudio.isVisible()) await startAudio.click();
    stage = 'remote_audio_playback';
    await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => audio.srcObject instanceof MediaStream && audio.srcObject.getAudioTracks().some((track) => track.readyState === 'live') && !audio.paused && audio.readyState >= 2), undefined, { timeout: 30_000 });
    remoteAudioPeak = await measureRemotePcm(page);
    audioPlayback = true;

    stage = 'worker_stt_warranty_question';
    await expect.poll(async () => (await page.locator('.voice-transcript-row.user').allTextContents()).join('\n'), { timeout }).toMatch(/гарант/i);
    userTranscribed = true;
    stage = 'worker_answer_sources';
    await expect(page.locator('.voice-answer-sources')).toContainText(/гарант/i, { timeout });
    citedAnswer = true;
    stage = 'worker_answer_audio';
    answerAudioPeak = await measureRemotePcm(page);
    stage = 'worker_answer_12_months';
    await expect.poll(async () => (await page.locator('.voice-transcript-row.assistant').allTextContents()).join('\n'), { timeout }).toMatch(/12|двенадц/i);
    guaranteePreserved = true;
    await expect(page.locator('.voice-model-warning')).toHaveCount(0);
    stage = 'worker_answer_finished';
    await expect(page.locator('.voice-stage h2')).toHaveText('Агент слушает вас', { timeout });

    stage = 'microphone_mute';
    await page.getByRole('button', { name: 'Выключить микрофон', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Включить микрофон', exact: true })).toBeVisible();
    await page.waitForFunction(() => window.__liniyaCapturedTracks.length > 0 && window.__liniyaCapturedTracks.every((track) => track.readyState === 'ended' || !track.enabled), undefined, { timeout: 10_000 });
    microphoneMuted = true;
    stage = 'disconnect';
    await page.getByRole('button', { name: 'Завершить разговор', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Начать голосовой разговор', exact: true })).toBeVisible();
    await expect(page.locator('.voice-livekit')).toHaveCount(0);
    disconnected = true;
    stage = 'release_capture_tracks';
    await page.waitForFunction(() => window.__liniyaCapturedTracks.length > 0 && window.__liniyaCapturedTracks.every((track) => track.readyState === 'ended'), undefined, { timeout: 10_000 });
    capturedTrackCount = await page.evaluate(() => window.__liniyaCapturedTracks.length);
    tracksReleased = true;
    if (errors.length) throw new Error('Browser emitted an uncaught page error');

    emit({
      check: 'browser_voice', outcome: 'passed', passed: true,
      production_ui: true, rtc_connected: connected, microphone_source: `Chromium fake capture of ${inputSource}`,
      actual_remote_audio_playback: audioPlayback, remote_pcm_peak: Number(remoteAudioPeak.toFixed(6)), actual_worker_transcribed_warranty: userTranscribed,
      actual_worker_cited_answer: citedAnswer, warranty_12_months_preserved: guaranteePreserved,
      actual_worker_answer_audio: answerAudioPeak > 0.001, answer_remote_pcm_peak: Number(answerAudioPeak.toFixed(6)),
      microphone_mute_control: microphoneMuted, disconnected, captured_track_count: capturedTrackCount, captured_tracks_released: tracksReleased,
      elapsed_seconds: Math.round((Date.now() - started) / 1000),
      not_tested: ['Physical human microphone and room acoustics', 'Physical speaker audibility', 'Manual microphone permission UX', 'Boson API', 'Telephone network'],
    });
  } catch (error) {
    // Avoid logging session responses, JWTs, RTC URLs, or full browser diagnostics.
    let uiDiagnostics;
    if (page && !page.isClosed()) {
      uiDiagnostics = await page.evaluate(() => ({
        livekit_container: Boolean(document.querySelector('.voice-livekit')),
        error_notice: Boolean(document.querySelector('.notice.error')),
        model_warning: Boolean(document.querySelector('.voice-model-warning')),
        captured_tracks: (window.__liniyaCapturedTracks || []).map((track) => ({ ready_state: track.readyState, enabled: track.enabled })),
        peer_connections: window.__liniyaPeerConnections,
      })).catch(() => undefined);
      if (process.env.VOICE_CHECK_SCREENSHOT) await page.screenshot({ path: resolve(process.env.VOICE_CHECK_SCREENSHOT), fullPage: true }).catch(() => {});
    }
    emit({ check: 'browser_voice', outcome: 'failed', passed: false, stage, failed_check: error instanceof Error ? error.name : 'UnknownError', rtc_connected: connected, audio_playback: audioPlayback, user_transcribed: userTranscribed, cited_answer: citedAnswer, guarantee_preserved: guaranteePreserved, microphone_muted: microphoneMuted, disconnected, captured_tracks_released: tracksReleased, page_error_names: errors, session_http_statuses: sessionHttpStatuses, websocket_count: websocketCount, websocket_errors: websocketErrors, console: consoleDiagnostics, ui: uiDiagnostics });
    process.exitCode = 1;
  } finally {
    if (page && !page.isClosed()) {
      try { const disconnect = page.getByRole('button', { name: 'Завершить разговор', exact: true }); if (await disconnect.isVisible()) await disconnect.click({ timeout: 3_000 }); } catch { /* Closing the browser releases the RTC participant and capture tracks. */ }
    }
    await browser?.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch(() => { emit({ check: 'browser_voice', outcome: 'failed', reason: 'Unable to prepare or run the browser check' }); process.exitCode = 1; });
