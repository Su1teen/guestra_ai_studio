import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Открыть локальную студию" }).click();
  await expect(
    page.getByRole("heading", { name: "Разговоры", exact: true }),
  ).toBeVisible();
  if (!testInfo.title.startsWith("creates guest")) {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const title = "Browser fixture " + Date.now();
    await page.request.post("/api/conversations", {
      data: {
        clientId: boot.clients[0].id,
        title,
        channel: "whatsapp",
        stage: "new_contact",
      },
    });
    await page.reload();
    await page.locator(".conversation-item").filter({ hasText: title }).click();
  }
});
test("creates guest, chat, persists draft, sends and reviews", async ({
  page,
}, testInfo) => {
  const name = "Тестовый гость " + Date.now();
  await page
    .getByRole("button", { name: "Добавить клиента", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Имя", { exact: true }).fill("Тест");
  await modal.getByLabel("Фамилия", { exact: true }).fill("Гость");
  await modal.getByLabel("Имя в чате").fill(name);
  await modal.getByRole("button", { name: "Сохранить клиента" }).click();
  await expect(modal).toBeHidden();
  await page
    .getByRole("button", { name: "Новый разговор", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Виртуальный клиент")
    .selectOption({ label: name });
  await page
    .getByRole("dialog")
    .getByLabel("Название")
    .fill("Проверка браузера " + name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Создать разговор" })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Сообщение гостя" });
  await input.fill("Черновик из браузера");
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/bootstrap");
      return (await response.json()).conversations.find(
        (c: { title: string }) => c.title === "Проверка браузера " + name,
      )?.draft;
    })
    .toBe("Черновик из браузера");
  await page.reload();
  if (testInfo.project.name === "mobile")
    await page.getByRole("button").filter({ hasText: name }).click();
  await expect(input).toHaveValue("Черновик из браузера");
  await input.fill("Здравствуйте! https://example.com");
  await input.press("Enter");
  await expect(
    page.getByRole("link", { name: "https://example.com", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Спасибо! Это пример ответа Local Preview.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Заметки и оценка", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Комментарий тестировщика" })
    .fill("Проверить понимание дат");
  await page.getByRole("button", { name: "Добавить заметку" }).click();
  await expect(
    page.getByText("Проверить понимание дат", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-review.png`,
  });
});
test("prompt drafts, version comparison and virtual calls work", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Агенты", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Системный промпт" })
    .fill("Тестовый промпт. Проверяй данные через APIs.");
  await page
    .getByRole("button", { name: /Сохранить как черновик|Сохранить черновик/ })
    .click();
  await expect(page.getByText("Черновик сохранён в PostgreSQL")).toBeVisible();
  await page.getByRole("button", { name: "Сравнить с активным" }).click();
  await expect(page.locator(".prompt-diff")).toBeVisible();
  await page.getByRole("button", { name: "Чаты", exact: true }).click();
  if (testInfo.project.name === "mobile")
    await page.locator(".conversation-item").first().click();
  await page
    .getByRole("button", { name: "Исходящий виртуальный звонок" })
    .click();
  await page.getByRole("button", { name: "Принять", exact: true }).click();
  await expect(
    page.getByText("Сессия активна", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Реплика звонка" })
    .fill("Здравствуйте, нужна помощь");
  await page.getByRole("button", { name: "Добавить реплику" }).click();
  await expect(
    page.getByText("Здравствуйте, нужна помощь", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Завершить звонок" }).click();
  await expect(page.getByText("Исходящий · Завершён")).toBeVisible();
});
test("media upload, image preview, PDF download and audio playback", async ({
  page,
}) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRj0AAAAASUVORK5CYII=",
    "base64",
  );
  const wav = Buffer.alloc(8044);
  wav.write("RIFF");
  wav.writeUInt32LE(8036, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(8000, 40);
  wav.fill(128, 44);
  await page.locator("input[type=file][hidden]").setInputFiles([
    { name: "test-pixel.png", mimeType: "image/png", buffer: png },
    {
      name: "test.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"),
    },
    { name: "test-audio.wav", mimeType: "audio/wav", buffer: wav },
  ]);
  await expect(
    page.locator(".upload-item").filter({ hasText: "Готово" }),
  ).toHaveCount(3);
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await expect(page.getByRole("img", { name: "test-pixel.png" })).toBeVisible();
  await page.getByRole("button", { name: "Открыть test-pixel.png" }).click();
  await expect(
    page.getByRole("dialog", { name: "Просмотр изображения" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /test.pdf/ }).click();
  expect((await download).suggestedFilename()).toBe("test.pdf");
  await expect(page.locator("audio")).toBeVisible();
  await page.locator("audio").evaluate(async (audio) => {
    await (audio as HTMLAudioElement).play();
  });
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluate((a) => (a as HTMLAudioElement).currentTime),
    )
    .toBeGreaterThan(0);
});
