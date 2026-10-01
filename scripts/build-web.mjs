import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageWebSource } from './package-web-source.mjs';
import { resolve } from 'node:path';

export function frontendBuildEnv(mode, input = process.env) {
  if (!['production', 'mocked', 'dev', 'dev:mocked'].includes(mode)) throw new Error('Invalid frontend build mode');
  const isMocked = mode === 'mocked' || mode === 'dev:mocked';
  const apiId = isMocked ? '1' : input.WEB_TELEGRAM_API_ID;
  const apiHash = isMocked ? '11111111111111111111111111111111' : input.WEB_TELEGRAM_API_HASH;
  if (!apiId || !/^[1-9]\d*$/.test(apiId) || !Number.isSafeInteger(Number(apiId)) || !apiHash || !/^[a-fA-F0-9]{32}$/.test(apiHash)) {
    throw new Error('Frontend requires explicit WEB_TELEGRAM_API_ID and WEB_TELEGRAM_API_HASH');
  }
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'CI'].filter(key => input[key]).map(key => [key, input[key]]));
  return {...env, TG_BRIDGE_FRONTEND_BUILD: '1', TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash, APP_ENV: isMocked ? 'test' : mode === 'dev' ? 'development' : 'production', APP_MOCKED_CLIENT: isMocked ? '1' : '', BASE_URL: 'https://tg-mcp.azimboev.uz', APP_TITLE: 'TG Bridge', APP_NAME: 'TG Bridge'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? 'production';
    const env = frontendBuildEnv(mode);
    if (process.argv.includes('--validate')) {
      console.log(JSON.stringify({mode, title: env.APP_TITLE, baseUrl: env.BASE_URL}));
    } else {
      const command = {production: 'build:production', mocked: 'build:mocked', dev: 'dev', 'dev:mocked': 'dev:mocked'}[mode];
      const child = spawn('npm', ['run', command], {cwd: new URL('../apps/web/', import.meta.url), env, stdio: 'inherit'});
      child.once('error', () => { console.error('Unable to start frontend builder'); process.exitCode = 1; });
      child.once('exit', async code => {
        process.exitCode = code ?? 1;
        if (code === 0 && (mode === 'production' || mode === 'mocked')) {
          try { await packageWebSource({ root: fileURLToPath(new URL('../', import.meta.url)),
            output: fileURLToPath(new URL('../apps/web/dist/', import.meta.url)) }); }
          catch (error) { console.error(error.message); process.exitCode = 1; }
        }
      });
      process.once('SIGTERM', () => child.kill('SIGTERM'));
      process.once('SIGINT', () => child.kill('SIGINT'));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
