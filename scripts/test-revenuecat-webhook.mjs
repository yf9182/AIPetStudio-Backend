import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac, webcrypto } from "node:crypto";
import { build } from "esbuild";
import { test } from "node:test";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const directory = await mkdtemp(join(tmpdir(), "ai-pet-studio-webhook-"));
const bundlePath = join(directory, "worker.mjs");

try {
  await build({
    entryPoints: [join(process.cwd(), "src/index.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "neutral",
    target: "es2022",
    logLevel: "silent"
  });

  const worker = await import(pathToFileURL(bundlePath).href);
  const secret = "test-revenuecat-signing-secret";
  const body = JSON.stringify({ event: { type: "VIRTUAL_CURRENCY_TRANSACTION" } });
  const timestamp = 1_700_000_000;
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  const env = { REVENUECAT_WEBHOOK_SIGNING_SECRET: secret };

  await test("accepts RevenueCat's timestamped HMAC format", async () => {
    assert.equal(await worker.verifyRevenueCatSignature(env, body, header, timestamp * 1000), true);
  });

  await test("rejects a modified body", async () => {
    assert.equal(await worker.verifyRevenueCatSignature(env, `${body} `, header, timestamp * 1000), false);
  });

  await test("rejects a stale signature", async () => {
    assert.equal(await worker.verifyRevenueCatSignature(env, body, header, (timestamp + 301) * 1000), false);
  });

  await test("rejects the old raw-body-only signature format", async () => {
    const legacySignature = createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(await worker.verifyRevenueCatSignature(env, body, legacySignature, timestamp * 1000), false);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
