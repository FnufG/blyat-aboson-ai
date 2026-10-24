import { test, expect } from "@playwright/test";

test("FAQ answers cite a source, unknown questions abstain, and follow-up keeps context", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Поиск по FAQ", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "На роутере мигает красный индикатор", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("не установил соединение с провайдером");
  await expect(page.getByRole("log")).toContainText("Источники ответа");
  const input = page.getByRole("textbox", { name: "Сообщение клиента" });
  await input.fill("А если это не помогло?");
  await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("Уточните, какой шаг");
  await input.fill("Какая погода завтра?");
  await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("В базе знаний нет подтверждённого ответа");
  await page.reload();
  await expect(page.getByRole("log")).toContainText("Какая погода завтра?");
});

test("own FAQ replaces demo data, persists, and is used by chat", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /База знаний/ }).first().click();
  await page.getByLabel("Загрузить базу знаний из файла").setInputFiles({
    name: "company.md", mimeType: "text/markdown",
    buffer: Buffer.from("## Как получить акт сверки?\n\nНапишите на billing@example.invalid. Ответ в течение двух рабочих дней.")
  });
  await expect(page.getByText("Как получить акт сверки?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Тестовый диалог/ }).first().click();
  const input = page.getByRole("textbox", { name: "Сообщение клиента" });
  await input.fill("Как получить акт сверки?");
  await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("billing@example.invalid");
  await page.reload();
  await expect(page.getByRole("log")).toContainText("billing@example.invalid");
  await page.getByRole("button", { name: /База знаний/ }).first().click();
  await page.getByRole("button", { name: "Редактировать: Как получить акт сверки?" }).click();
  await page.getByLabel("Проверенный ответ").fill("Пишите на finance@example.invalid.");
  await page.getByRole("button", { name: "Сохранить материал" }).click();
  await page.getByRole("button", { name: /Тестовый диалог/ }).first().click();
  await expect(page.getByRole("log")).not.toContainText("billing@example.invalid");
  await input.fill("Как получить акт сверки?");
  await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("finance@example.invalid");
});

test("invalid import leaves the previous knowledge intact", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /База знаний/ }).first().click();
  await page.getByLabel("Загрузить базу знаний из файла").setInputFiles({ name: "empty.md", mimeType: "text/markdown", buffer: Buffer.from("") });
  await expect(page.getByRole("alert").filter({ hasText: "Документ пуст" })).toBeVisible();
  await expect(page.getByText("Как связаться с поддержкой?", { exact: true })).toBeVisible();
});

test("mobile layout stays within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Сообщение клиента" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/liniya-mobile.png", fullPage: true });
});
