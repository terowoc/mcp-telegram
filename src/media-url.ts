import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";
import { basename, extname } from "node:path";
import { type MediaUploadStore, mediaUploadStore, type UploadedMedia, validateMediaName } from "./media-upload.js";
import { operationSignal } from "./operation-context.js";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");

export function isPublicMediaAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

type Dependencies = {
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof get;
  mimeType?: string;
  maxBytes?: number;
};
export const MEDIA_DOWNLOAD_BYTES = 20 * 1048576;
const extensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};
function filename(url: URL, response: IncomingMessage, override?: string, nativeMime?: string): string {
  if (override) return validateMediaName(override);
  const disposition = response.headers["content-disposition"] ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"\r\n]+)"|filename=([^;\r\n]+)/i.exec(disposition);
  let name = encoded ? decodeURIComponent(encoded) : (plain?.[1] ?? plain?.[2]?.trim());
  if (!name) name = decodeURIComponent(basename(url.pathname)) || "download";
  const responseMime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
  const mime = extensions[responseMime]
    ? responseMime
    : (nativeMime?.split(";")[0].trim().toLowerCase() ?? responseMime);
  if (!extname(name)) name += extensions[mime] ?? ".bin";
  return validateMediaName(name);
}

/** Validate every redirect and pin the checked DNS result to the TLS connection. */
export async function importMediaUrl(
  value: string,
  fileName?: string,
  store: MediaUploadStore = mediaUploadStore(),
  deps: Dependencies = {},
): Promise<UploadedMedia> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(15000),
    ...(operationSignal() ? [operationSignal() as AbortSignal] : []),
  ]);
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const request = deps.request ?? get;
  let next = value;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      throw new Error("Media URL must be a downloadable HTTPS URL");
    }
    if (
      next.length > 8192 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new Error("Media URL must use HTTPS on port 443 without embedded credentials");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host.toLowerCase() === "localhost" || /\.localhost\.?$/i.test(host))
      throw new Error("Media URL must resolve to a public address");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address)))
      throw new Error("Media URL must resolve only to public addresses");
    const pinned = addresses[0];
    const response = await new Promise<IncomingMessage>((accept, reject) => {
      const req = request(
        url,
        {
          agent: false,
          signal,
          headers: { Accept: "*/*", "Accept-Encoding": "identity" },
          lookup: (_hostname, options, callback) => {
            if (typeof options === "object" && options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        accept,
      );
      req.once("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy();
      if (!response.headers.location || redirects === 3) throw new Error("Media URL has too many or invalid redirects");
      next = new URL(response.headers.location, url).href;
      continue;
    }
    try {
      if (response.statusCode !== 200)
        throw new Error(`Media URL download failed (HTTP ${response.statusCode}); use a direct downloadable URL`);
      const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (mime === "text/html" || mime === "application/xhtml+xml")
        throw new Error("Media URL returned HTML; provide a direct downloadable file URL");
      const maxBytes = Math.min(
        Number(process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES ?? MEDIA_DOWNLOAD_BYTES),
        deps.maxBytes ?? Number.POSITIVE_INFINITY,
      );
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes) throw new Error("Media size exceeds configured limit");
      return await store.importStream(filename(url, response, fileName, deps.mimeType), response, maxBytes);
    } finally {
      response.destroy();
    }
  }
  throw new Error("Media URL redirect limit reached");
}
