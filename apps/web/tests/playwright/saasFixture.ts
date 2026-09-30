import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function startBackendFixture(page: Page) {
  const root = new URL('../../../../', import.meta.url);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/__tests__/fixtures/saas-browser.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (data) => {
      output += data.toString();
      const match = output.match(/\{"port":(\d+)\}/);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error('Browser backend fixture exited before readiness')));
    child.once('error', reject);
  });
  await page.route('**/api/saas/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `http://127.0.0.1:${port}${url.pathname}`,
      headers: {
        ...route.request().headers(),
        origin: 'https://localhost',
        host: 'localhost',
        'x-forwarded-proto': 'https',
      },
    });
    await route.fulfill({ response });
  });
  return async () => {
    child.kill('SIGTERM');
    await once(child, 'exit');
  };
}
