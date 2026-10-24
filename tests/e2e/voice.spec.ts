import { test, expect } from "@playwright/test";

test("voice status is real and an empty knowledge base cannot start a conversation", async ({ page, request }) => {
  const response=await request.get("/api/voice/status");
  expect(response.ok()).toBe(true);
  const status=await response.json(); expect(typeof status.ready).toBe("boolean");
  await page.goto("/");
  await page.getByRole("button",{name:"Voice conversation",exact:true}).click();
  const start=page.getByRole("button",{name:"Start voice conversation",exact:true});
  await expect(start).toBeVisible(); await expect(start).toBeDisabled();
  if(status.ready) await expect(page.getByText("Voice service is ready to connect",{exact:true})).toBeVisible();
  else {
    await expect(page.getByText("Voice service is not ready yet.",{exact:true})).toBeVisible();
    if(Array.isArray(status.missing)&&status.missing.length){
      await page.getByText("What is needed to start",{exact:true}).click();
      await expect(page.getByText(status.missing[0],{exact:true})).toBeVisible();
    }
  }
  await expect(page.getByText("Channel: connected",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"End conversation",exact:true})).toHaveCount(0);
});

test("microphone permission failure never creates or fabricates a voice session", async ({ page }) => {
  // Only readiness and capture denial are fixtures; no successful RTC/model conversation is mocked.
  await page.route("**/api/voice/status",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ready:true,missing:[],ttsProvider:"test",details:"Permission error test fixture only."})}));
  let sessionRequests=0;
  await page.route("**/api/voice/session",route=>{sessionRequests++;return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"No session is expected in this test."})});});
  await page.addInitScript(()=>{
    const getUserMedia=async()=>{throw new DOMException("Test permission denied","NotAllowedError");};
    if(navigator.mediaDevices)Object.defineProperty(navigator.mediaDevices,"getUserMedia",{configurable:true,value:getUserMedia});
    else Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia}});
  });
  await page.goto("/");
  await page.getByRole("button",{name:/Knowledge base/}).first().click();
  await page.getByLabel("Upload knowledge base file").setInputFiles({name:"company.md",mimeType:"text/markdown",buffer:Buffer.from("## When are you open?\n\nDaily 09:00 to 18:00.")});
  await page.getByRole("button",{name:"Voice conversation",exact:true}).click();
  const start=page.getByRole("button",{name:"Start voice conversation",exact:true});
  await expect(start).toBeEnabled(); await start.click();
  const alert=page.getByRole("alert").filter({hasText:/microphone access/i});
  await expect(alert).toBeVisible(); await expect(alert).toContainText(/site settings/i);
  await expect(start).toBeEnabled(); expect(sessionRequests).toBe(0);
  await expect(page.getByText("Channel: connected",{exact:true})).toHaveCount(0);
  await expect(page.getByText("The agent is listening",{exact:true})).toHaveCount(0);
});
