import { generateKeyPairSync, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 16 || password.length > 1024) throw new Error("Owner password must contain 16–1024 characters");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (password.length > 1024) return false;
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(hash);
  if (!match) return false;
  const actual = await derive(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(actual, Buffer.from(match[2], "hex"));
}

export interface PersistentSecrets {
  cookieKeys: string[];
  jwks: { keys: Array<Record<string, unknown>> };
}

export async function loadOrCreateSecrets(dir: string): Promise<PersistentSecrets> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "secrets.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as PersistentSecrets;
    if (!Array.isArray(value.cookieKeys) || value.cookieKeys.length < 2 || !value.jwks?.keys?.[0]?.d) {
      throw new Error("Invalid persistent OAuth secrets");
    }
    await chmod(path, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const value: PersistentSecrets = {
    cookieKeys: [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")],
    jwks: { keys: [{ ...privateKey.export({ format: "jwk" }), kid: randomUUID(), use: "sig", alg: "RS256" }] },
  };
  try {
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateSecrets(dir);
    throw error;
  }
}
