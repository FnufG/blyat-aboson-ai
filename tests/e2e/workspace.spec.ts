import { test, expect, type Page } from "@playwright/test";

async function upload(page: Page, content: string) {
  await page.getByRole("button", { name: /Knowledge base/ }).first().click();
  await page.getByLabel("Upload knowledge base file").setInputFiles({name:"company.md",mimeType:"text/markdown",buffer:Buffer.from(content)});
}

test("starts empty without demo questions, then answers only uploaded information", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", {name:"Send message",exact:true})).toBeDisabled();
  await expect(page.getByText("TechnoLiniya",{exact:false})).toHaveCount(0);
  await expect(page.getByRole("button",{name:/warranty terms|blinking red|contact support/i})).toHaveCount(0);
  await upload(page, "## Why is the router indicator blinking red?\n\nA blinking red indicator means no provider connection. Check the WAN cable, then restart the router.");
  await page.getByRole("button",{name:"Test chat",exact:true}).click();
  await expect(page.getByText("FAQ search",{exact:true}).first()).toBeVisible();
  const input=page.getByRole("textbox",{name:"Customer message"});
  await input.fill("Why is the router indicator blinking red?"); await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("no provider connection");
  await expect(page.getByRole("log")).toContainText("Answer sources");
  await input.fill("What if that did not help?"); await input.press("Enter");
  await expect(page.getByRole("log")).toContainText(/clarify|which step/i);
  await input.fill("What is tomorrow's weather?"); await input.press("Enter");
  await expect(page.getByRole("log")).toContainText(/no verified answer|does not contain a verified answer/i);
  await page.reload();
  await expect(page.getByRole("log")).toContainText("What is tomorrow's weather?");
});

test("own company information persists and changes are used by chat", async ({ page }) => {
  await page.goto("/");
  await upload(page,"## How can I get a billing statement?\n\nEmail billing@example.invalid. Replies arrive within two working days.");
  await expect(page.getByText("How can I get a billing statement?",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Test chat",exact:true}).click();
  const input=page.getByRole("textbox",{name:"Customer message"});
  await input.fill("How can I get a billing statement?"); await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("billing@example.invalid");
  await page.reload();
  await expect(page.getByRole("log")).toContainText("billing@example.invalid");
  await page.getByRole("button",{name:/Knowledge base/}).first().click();
  await page.getByRole("button",{name:"Edit: How can I get a billing statement?"}).click();
  await page.getByLabel("Verified answer").fill("Email finance@example.invalid.");
  await page.getByRole("button",{name:"Save entry"}).click();
  await page.getByRole("button",{name:"Test chat",exact:true}).click();
  await expect(page.getByRole("log")).not.toContainText("billing@example.invalid");
  await input.fill("How can I get a billing statement?"); await input.press("Enter");
  await expect(page.getByRole("log")).toContainText("finance@example.invalid");
});

test("invalid import preserves the existing uploaded knowledge", async ({ page }) => {
  await page.goto("/");
  await upload(page,"## When are you open?\n\nWe are open daily from 09:00 to 18:00.");
  await page.getByLabel("Upload knowledge base file").setInputFiles({name:"empty.md",mimeType:"text/markdown",buffer:Buffer.from("")});
  await expect(page.getByRole("alert").filter({hasText:/document is empty/i})).toBeVisible();
  await expect(page.getByText("When are you open?",{exact:true})).toBeVisible();
});

test("English mobile layout stays inside the viewport", async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); await page.goto("/");
  await expect(page.getByRole("textbox",{name:"Customer message"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:"/tmp/liniya-mobile.png",fullPage:true});
});
