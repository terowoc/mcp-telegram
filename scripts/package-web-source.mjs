import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUILD_GUIDE = `# TG Bridge corresponding frontend source

License: GPL-3.0-or-later. See apps/web/LICENSE and apps/web/UPSTREAM.md.
The separate server in the repository retains its MIT license.
Use Node 24.15+ or Node 26 and npm 11+.

npm --prefix apps/web ci --allow-git=all
node scripts/build-web.mjs mocked

For live chats, set WEB_TELEGRAM_API_ID and WEB_TELEGRAM_API_HASH to a
browser Telegram application's public credentials, then run:
node scripts/build-web.mjs production

Private server keys, sessions and local environment files are not distributed.
SOURCE_FILES.json is the exact build-source inventory. Preserve upstream
copyright and third-party notices when distributing modified versions.
`;
const EXTRA_FILES = ['scripts/build-web.mjs', 'scripts/package-web-source.mjs', 'apps/web/SOURCE_FILES.json'];

function createTarEntry(path, data, mode) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const parts = path.split('/');
    name = parts.pop();
    prefix = parts.join('/');
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Archive path is too long');
  header.write(name, 0, 100);
  for (const [offset, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]])
    header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
}

export async function packageWebSource({ root, output }) {
  root = await realpath(resolve(root));
  const inventory = JSON.parse(await readFile(join(root, 'apps/web/SOURCE_FILES.json'), 'utf8'));
  if (!Array.isArray(inventory)) throw new Error('Invalid frontend source inventory');
  const files = [...new Set([...inventory, ...EXTRA_FILES])].sort();
  const entries = [];
  for (const path of files) {
    if (typeof path !== 'string' || (!path.startsWith('apps/web/') && !EXTRA_FILES.includes(path))
      || path.split('/').some(part => ['.', '..', '.git', '.cache', 'node_modules', 'dist', 'test-results',
        'playwright-report', 'target'].includes(part) || (part.startsWith('.env') && part !== '.env.example'))
      || /\.(?:key|pem|sqlite|db)$/.test(path)) throw new Error('Unsafe frontend source path');
    if (await realpath(join(root, path)) !== join(root, path)) throw new Error('Frontend source symlink is forbidden');
    const metadata = await lstat(join(root, path));
    if (!metadata.isFile()) throw new Error('Frontend source must be a regular file');
    const data = await readFile(join(root, path));
    entries.push(...createTarEntry(path, data, metadata.mode & 0o111 ? 0o755 : 0o644));
  }
  entries.push(...createTarEntry('README.md', Buffer.from(BUILD_GUIDE), 0o644), Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(entries), { level: 9 });
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const sourceDir = join(output, 'source');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'tg-bridge-source.tar.gz'), archive);
  await writeFile(join(sourceDir, 'LICENSE.txt'), await readFile(join(root, 'apps/web/LICENSE')));
  await writeFile(join(sourceDir, 'UPSTREAM.md'), await readFile(join(root, 'apps/web/UPSTREAM.md')));
  await writeFile(join(sourceDir, 'README.md'), BUILD_GUIDE);
  await writeFile(join(sourceDir, 'SHA256SUMS'), `${sha256}  tg-bridge-source.tar.gz\n`);
  return { sha256, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await packageWebSource({ root, output: resolve(process.argv[2] || join(root, 'apps/web/dist')) });
  console.log(`Packaged ${result.files.length} frontend source files (${result.sha256})`);
}
