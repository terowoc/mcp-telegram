import { connectionUi } from "./pages.js";

export const DOWNLOAD_SCRIPT_PATH = "/media/download-client.js";
export function downloadPage(cookie?: string): string {
  return connectionUi(cookie).page(
    "Скачать файл из Telegram",
    "Сохраните файл на своё устройство. Ссылка действует пять минут после того, как файл готов.",
    `<div class="actions"><button class="button" id="download">Скачать файл</button></div><p id="status" role="status" aria-live="polite"></p><p class="help">Если ссылка устарела, попросите AI-клиент создать новую.</p><script type="module" src="${DOWNLOAD_SCRIPT_PATH}"></script>`,
  );
}

// The fragment never reaches HTTP access logs. Send its capability only in a header.
export const DOWNLOAD_SCRIPT = String.raw`
const button = document.querySelector('#download');
const status = document.querySelector('#status');
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  button.disabled = true;
  status.textContent = 'Откройте полную ссылку из AI-клиента или получите новую.';
} else button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Подготавливаем скачивание…';
  const mb = (n) => (n / 1048576).toFixed(1) + ' МБ';
  try {
    let response;
    // A large file may still be coming from Telegram: the server answers 202 until it is ready.
    for (;;) {
      response = await fetch(location.pathname, {headers: {Authorization: 'Bearer ' + token}, cache: 'no-store'});
      if (response.status !== 202) break;
      const progress = await response.json().catch(() => ({}));
      status.textContent = 'Файл ещё загружается из Telegram: ' + mb(progress.receivedBytes || 0) + '…';
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!response.ok) throw new Error('unavailable');
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition)?.[1];
    const plain = quoted?.replace(/\\(.)/g, '$1');
    const filename = encoded ? decodeURIComponent(encoded) : plain || 'telegram-file.bin';
    // Count bytes as they pass to show progress on large files (up to 2000 MiB); Response.blob()
    // lets the browser keep the file in its own blob storage instead of page memory.
    const total = Number(response.headers.get('content-length')) || 0;
    let loaded = 0;
    const counted = response.body.pipeThrough(new TransformStream({
      transform(chunk, stream) {
        loaded += chunk.length;
        if (total) status.textContent = 'Скачивается: ' + mb(loaded) + ' из ' + mb(total);
        stream.enqueue(chunk);
      },
    }));
    const blob = await new Response(counted).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.className = 'button';
    link.textContent = 'Скачать ' + filename;
    button.replaceWith(link); link.click();
    status.textContent = 'Файл готов. Если скачивание не началось, нажмите ссылку.';
    window.addEventListener('pagehide', () => URL.revokeObjectURL(url), {once:true});
  } catch {
    button.disabled = false;
    status.textContent = 'Файл недоступен или ссылка устарела. Получите новую ссылку в AI-клиенте.';
  }
});
`;
