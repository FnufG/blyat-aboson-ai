import { test, expect } from "@playwright/test";

test("voice screen reflects the real service status and never claims a connection before starting", async ({ page, request }) => {
  // This is a real readiness check. It does not synthesize an audio conversation.
  const response = await request.get("/api/voice/status");
  expect(response.ok()).toBe(true);
  const status = await response.json();
  expect(typeof status.ready).toBe("boolean");
  await page.goto("/");
  await page.getByRole("button", { name: "Голосовой диалог", exact: true }).click();
  const start = page.getByRole("button", { name: "Начать голосовой разговор", exact: true });
  await expect(start).toBeVisible();
  if (status.ready) {
    await expect(page.getByText("Голосовой сервис готов к подключению", { exact: true })).toBeVisible();
    await expect(start).toBeEnabled();
  } else {
    await expect(page.getByText("Голосовой сервис пока не готов.", { exact: true })).toBeVisible();
    await expect(start).toBeDisabled();
    if (Array.isArray(status.missing) && status.missing.length) {
      await page.getByText("Что требуется для запуска", { exact: true }).click();
      await expect(page.getByText(status.missing[0], { exact: true })).toBeVisible();
    }
  }
  await expect(page.getByText("Канал: подключён", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Завершить разговор", exact: true })).toHaveCount(0);
});

test("microphone permission failure is actionable and never requests or fabricates a voice session", async ({ page }) => {
  // Mock readiness only to exercise the browser permission error path. There is
  // no mocked successful WebRTC connection and no claim that any model spoke.
  await page.route("**/api/voice/status", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ready: true, missing: [], ttsProvider: "test", details: "Test fixture for microphone permission handling only." }),
  }));
  let sessionRequests = 0;
  await page.route("**/api/voice/session", (route) => {
    sessionRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "No session is expected in this permission test." }) });
  });
  await page.addInitScript(() => {
    const getUserMedia = async () => { throw new DOMException("Permission denied in the test", "NotAllowedError"); };
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: getUserMedia });
    } else {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Голосовой диалог", exact: true }).click();
  const start = page.getByRole("button", { name: "Начать голосовой разговор", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  const microphoneAlert = page.getByRole("alert").filter({ hasText: "Доступ к микрофону запрещён" });
  await expect(microphoneAlert).toBeVisible();
  await expect(microphoneAlert).toContainText("Доступ к микрофону запрещён");
  await expect(microphoneAlert).toContainText("Разрешите его в настройках сайта");
  await expect(start).toBeEnabled();
  expect(sessionRequests).toBe(0);
  await expect(page.getByText("Канал: подключён", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Агент слушает вас", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Завершить разговор", exact: true })).toHaveCount(0);
});
