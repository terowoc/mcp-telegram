import { expect, type Page, test } from '@playwright/test';

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'MCP и AI-клиенты' }).click();
  await expect(page.getByText('MCP · TG Bridge', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
}

test('Telegram mock chats load independently of the MCP panel', async ({ page }) => {
  await page.route('**/api/saas/me', (route) =>
    route.fulfill({ status: 401, json: { error: 'authentication-required' } }),
  );
  await page.goto('/#mockScenario=mcp');
  await expect(page.locator('.chat-list').getByText('Fixture Contact', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await openPanel(page);
  await expect(page.getByText('Подключите свой Telegram к AI-клиентам')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('MCP · TG Bridge', { exact: true })).not.toBeVisible();
  await page.locator('.chat-list').getByText('Fixture Contact', { exact: true }).click();
  await expect(page.getByText('Hello fixture!', { exact: false })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('MCP panel mock message');
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await expect(page.locator('[data-message-id="102"]').filter({
    hasText: 'MCP panel mock message',
  }).first()).toBeVisible();
  await openPanel(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-message-id="102"]').filter({
    hasText: 'MCP panel mock message',
  }).first()).toBeVisible();
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`real SaaS registration and independent QR device ${viewport.width} ${theme}`, async ({ page }) => {
      test.setTimeout(90000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      const { startBackendFixture } = await import('./saasFixture');
      const close = await startBackendFixture(page);
      try {
        await page.goto('/#mockScenario=mcp');
        await openPanel(page);
        await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).first().click();
        await expect(
          page.locator('form').getByRole('button', { name: 'Создать аккаунт', exact: true }),
        ).toBeVisible();
        await page.getByLabel('Логин TG Bridge', { exact: true }).fill('browser_fixture');
        await page.getByLabel('Пароль TG Bridge', { exact: true }).fill('synthetic browser account password');
        await page.locator('form').getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
        await expect(page.getByText('Сохраните коды восстановления', { exact: true })).toBeVisible();
        await expect(page.getByText('Вы вошли как browser_fixture', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Я сохранил коды' }).click();
        await page.getByRole('button', { name: 'Подключить Telegram', exact: true }).click();
        await expect(page.getByRole('img', { name: 'QR-код входа в Telegram для MCP' })).toBeVisible();
        await expect(page.getByLabel('Пароль двухэтапной аутентификации Telegram')).toBeVisible({
          timeout: 12000,
        });
        await page.getByLabel('Пароль двухэтапной аутентификации Telegram').fill('synthetic cloud password');
        await page.getByRole('button', { name: 'Подтвердить вход', exact: true }).click();
        await expect(page.getByText('Сессия MCP сохранена', { exact: true })).toBeVisible({ timeout: 12000 });
        await expect(page.getByText('Аккаунты Telegram отличаются.', { exact: false })).toBeVisible();
        await page.screenshot({ path: `test-results/mcp-${viewport.width}-${theme}.png` });
        await page.getByRole('button', { name: 'Права доступа', exact: true }).click();
        await page.getByRole('button', { name: 'Чтение и изменение', exact: true }).click();
        await page.getByRole('button', { name: 'Сохранить права', exact: true }).click();
        await expect(page.getByText('Текущие AI-клиенты потеряют доступ.', { exact: false })).toBeVisible();
        await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
        await page.getByRole('button', { name: 'Как подключить', exact: true }).click();
        await expect(page.getByLabel('Адрес MCP', { exact: true })).toHaveValue('https://localhost/mcp');
        await page.getByRole('button', { name: 'Аккаунт TG Bridge', exact: true }).click();
        await page.getByRole('button', { name: 'Удалить аккаунт TG Bridge', exact: true }).click();
        await expect(page.getByLabel('Пароль TG Bridge', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Выйти из TG Bridge', exact: true }).click();
        await expect(page.getByText('Подключите свой Telegram к AI-клиентам')).toBeVisible();
      } catch (error) {
        if (!page.isClosed()) await page.screenshot({ path: 'test-results/mcp-failure.png' });
        throw error;
      } finally {
        await close();
      }
    });
  }
}

test('expired cookie closes a password confirmation and clears all private fields', async ({ page }) => {
  const { startBackendFixture } = await import('./saasFixture');
  const close = await startBackendFixture(page);
  try {
    await page.goto('/#mockScenario=mcp');
    await openPanel(page);
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).first().click();
    const submit = page.locator('form').getByRole('button', { name: 'Создать аккаунт', exact: true });
    await expect(submit).toBeVisible();
    await page.getByLabel('Логин TG Bridge', { exact: true }).fill('browser_fixture');
    await page.getByLabel('Пароль TG Bridge', { exact: true }).fill('synthetic browser account password');
    await submit.click();
    await page.getByRole('button', { name: 'Я сохранил коды' }).click();
    await page.getByRole('button', { name: 'Подключить Telegram', exact: true }).click();
    await expect(page.getByLabel('Пароль двухэтапной аутентификации Telegram')).toBeVisible({ timeout: 12000 });
    await page.getByRole('button', { name: 'Аккаунт TG Bridge', exact: true }).click();
    await page.getByRole('button', { name: 'Удалить аккаунт TG Bridge', exact: true }).click();
    await page.getByLabel('Пароль TG Bridge', { exact: true }).fill('private password in confirmation');
    await page.context().clearCookies();
    await expect(page.getByText('Подключите свой Telegram к AI-клиентам')).toBeVisible({ timeout: 12000 });
    await expect(page.getByLabel('Пароль TG Bridge', { exact: true })).toHaveCount(1);
    await expect(page.getByLabel('Пароль TG Bridge', { exact: true })).toHaveValue('');
  } finally { await close(); }
});

test('recovery changes the password and a client can be revoked with confirmation', async ({ page }) => {
  const { startBackendFixture } = await import('./saasFixture');
  const close = await startBackendFixture(page);
  let isRevoked = false;
  await page.route('**/api/saas/clients**', async (route) => {
    if (route.request().method() === 'DELETE') {
      isRevoked = true;
      await route.fulfill({ json: { ok: true } });
    } else {
      await route.fulfill({ json: {
        clients: isRevoked ? [] : [{ grantId: 'fixture_grant', clientId: 'Fixture AI client', version: 1 }],
      } });
    }
  });
  try {
    await page.goto('/#mockScenario=mcp');
    await openPanel(page);
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).first().click();
    const submit = page.locator('form').getByRole('button', { name: 'Создать аккаунт', exact: true });
    await expect(submit).toBeVisible();
    await page.getByLabel('Логин TG Bridge', { exact: true }).fill('browser_fixture');
    await page.getByLabel('Пароль TG Bridge', { exact: true }).fill('synthetic browser account password');
    await submit.click();
    const code = (await page.locator('pre').innerText()).split('\n')[0];
    await page.getByRole('button', { name: 'Я сохранил коды' }).click();
    await page.getByRole('button', { name: 'AI-клиенты', exact: true }).click();
    await expect(page.getByText('Fixture AI client', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
    await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await expect(page.getByText('Fixture AI client', { exact: true })).not.toBeVisible();
    expect(isRevoked).toBe(true);
    await page.getByRole('button', { name: 'Аккаунт TG Bridge', exact: true }).click();
    await page.getByRole('button', { name: 'Выйти из TG Bridge', exact: true }).click();
    await page.getByRole('button', { name: 'Восстановить доступ', exact: true }).first().click();
    await expect(page.getByLabel('Код восстановления', { exact: true })).toBeVisible();
    await page.getByLabel('Логин TG Bridge', { exact: true }).fill('browser_fixture');
    await page.getByLabel('Код восстановления', { exact: true }).fill(code);
    await page.getByLabel('Новый пароль', { exact: true }).fill('recovered browser account password');
    await page.locator('form').getByRole('button', { name: 'Восстановить доступ', exact: true }).click();
    await expect(page.getByText('Пароль обновлён. Войдите с новым паролем.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Код восстановления', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Войти', exact: true }).first().click();
    await expect(page.getByLabel('Пароль TG Bridge', { exact: true })).toBeVisible();
    await page.getByLabel('Пароль TG Bridge', { exact: true }).fill('recovered browser account password');
    await page.locator('form').getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByText('Вы вошли как browser_fixture', { exact: true })).toBeVisible();
  } finally { await close(); }
});
