#!/usr/bin/env node

/*
 * Validate the checked-in pet sound bundle and optionally import it into the
 * private R2 bucket and D1 table. This script never fetches remote URLs while
 * a Worker request is running; the source URLs in the manifest are audit
 * records only.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const defaultManifest = join(projectDirectory, "assets/pet-translator/library/v1/manifest.json");
const allowedEmotions = ["happy", "excited", "affectionate", "calm", "curious", "play_invitation", "attention_seeking", "displeased", "afraid", "alert"];
const allowedSpecies = ["cat", "dog"];
const allowedIntensities = ["low", "medium", "high"];

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function sha256(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

const mp3BitratesMpeg1 = {
  1: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
};
const mp3BitratesMpeg2 = {
  1: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const mp3SampleRates = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000]
};

function mp3Frame(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  if (versionBits === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const version = versionBits === 3 ? 3 : versionBits === 2 ? 2 : 0;
  const layerNumber = 4 - layer;
  const bitrateList = version === 3 ? mp3BitratesMpeg1[layerNumber] : mp3BitratesMpeg2[layerNumber];
  const bitrate = bitrateList?.[bitrateIndex - 1];
  const sampleRate = mp3SampleRates[version]?.[sampleIndex];
  if (!bitrate || !sampleRate) return null;
  const samples = layerNumber === 1 ? 384 : layerNumber === 2 ? 1152 : (version === 3 ? 1152 : 576);
  const coefficient = layerNumber === 1 ? 12 : layerNumber === 3 && version !== 3 ? 72 : 144;
  const length = Math.floor((coefficient * bitrate * 1000) / sampleRate) + padding;
  if (length < 4 || offset + length > bytes.length) return null;
  return { length, sampleRate, samples };
}

function inspectMp3(bytes) {
  let start = 0;
  if (bytes.length >= 3 && String.fromCharCode(...bytes.subarray(0, 3)) === "ID3") {
    if (bytes.length < 10) return null;
    const sizeBytes = bytes.subarray(6, 10);
    if (sizeBytes.some(value => value > 0x7f)) return null;
    const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
    start = 10 + tagSize + ((bytes[5] & 0x10) ? 10 : 0);
  }
  const scanEnd = Math.min(bytes.length - 4, start + 128 * 1024);
  let first = null;
  let firstOffset = -1;
  for (let offset = start; offset <= scanEnd; offset += 1) {
    const frame = mp3Frame(bytes, offset);
    if (frame) {
      first = frame;
      firstOffset = offset;
      break;
    }
  }
  if (!first || firstOffset < 0) return null;
  let offset = firstOffset;
  let frames = 0;
  let samples = 0;
  while (offset < bytes.length) {
    const frame = mp3Frame(bytes, offset);
    if (!frame) break;
    if (frame.sampleRate !== first.sampleRate) break;
    frames += 1;
    samples += frame.samples;
    offset += frame.length;
  }
  if (frames < 2) return null;
  const durationSeconds = samples / first.sampleRate;
  return Number.isFinite(durationSeconds) && durationSeconds > 0 ? { durationSeconds } : null;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectDirectory, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function readManifest(manifestPath) {
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(raw)) throw new Error("manifest must contain an array");
  const ids = new Set();
  const hashes = new Set();
  const categoryCounts = new Map();
  const validated = [];
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`manifest item ${index} is not an object`);
    const item = value;
    const fields = ["id", "library_version", "species", "emotion", "intensity", "vocalization", "storage_key", "mime_type", "source_url", "source_title", "source_author", "source_license", "source_license_url", "downloaded_at", "sha256", "review_status"];
    for (const field of fields) if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(`manifest item ${index} is missing ${field}`);
    const normalizedHash = item.sha256.toLowerCase();
    if (ids.has(item.id)) throw new Error(`duplicate sound id: ${item.id}`);
    if (hashes.has(normalizedHash)) throw new Error(`duplicate sound SHA-256: ${item.sha256}`);
    if (item.library_version !== "v1") throw new Error(`manifest item ${item.id} has an unsupported library version`);
    if (!allowedSpecies.includes(item.species)) throw new Error(`manifest item ${item.id} has an unsupported species`);
    if (!allowedEmotions.includes(item.emotion)) throw new Error(`manifest item ${item.id} has an unsupported emotion`);
    if (!allowedIntensities.includes(item.intensity)) throw new Error(`manifest item ${item.id} has an unsupported intensity`);
    if (!/^pet-translator\/library\/v1\/[A-Za-z0-9_./-]+\.mp3$/.test(item.storage_key) || item.storage_key.includes("..")) throw new Error(`manifest item ${item.id} has an unsafe storage key`);
    if (item.mime_type !== "audio/mpeg") throw new Error(`manifest item ${item.id} must be audio/mpeg`);
    if (item.source_license !== "CC0" && item.source_license !== "Public Domain") throw new Error(`manifest item ${item.id} has a disallowed license`);
    if (!/^https:\/\//i.test(item.source_url) || !/^https:\/\//i.test(item.source_license_url)) throw new Error(`manifest item ${item.id} has an invalid source URL`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(item.downloaded_at)) throw new Error(`manifest item ${item.id} has an invalid download date`);
    if (!/^[0-9a-f]{64}$/i.test(item.sha256)) throw new Error(`manifest item ${item.id} has an invalid SHA-256`);
    if (!["pending", "approved", "rejected"].includes(item.review_status)) throw new Error(`manifest item ${item.id} has an invalid review status`);
    const duration = Number(item.duration_seconds);
    if (!Number.isFinite(duration) || duration < 2 || duration > 5) throw new Error(`manifest item ${item.id} must be between 2 and 5 seconds`);
    ids.add(item.id);
    hashes.add(normalizedHash);
    const category = `${item.species}:${item.emotion}`;
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    validated.push({ ...item, sha256: item.sha256.toLowerCase(), duration_seconds: Math.round(duration * 1000) / 1000 });
  }
  if (validated.length !== 80) throw new Error(`manifest must contain exactly 80 records; found ${validated.length}`);
  for (const species of allowedSpecies) for (const emotion of allowedEmotions) {
    const count = categoryCounts.get(`${species}:${emotion}`) || 0;
    if (count !== 4) throw new Error(`${species}:${emotion} must contain 4 records; found ${count}`);
  }
  return validated;
}

async function validateFiles(manifest, manifestPath) {
  const failures = [];
  const seenPaths = new Set();
  for (const item of manifest) {
    const relativePath = item.storage_key.replace(/^pet-translator\/library\/v1\//, "");
    const filePath = join(projectDirectory, "assets/pet-translator/library/v1", relativePath);
    if (!filePath.startsWith(join(projectDirectory, "assets/pet-translator/library/v1")) || seenPaths.has(filePath)) {
      failures.push(`${item.id}: unsafe or duplicate local path`);
      continue;
    }
    seenPaths.add(filePath);
    if (!existsSync(filePath)) {
      failures.push(`${item.id}: missing ${relative(projectDirectory, filePath)}`);
      continue;
    }
    const bytes = await readFile(filePath);
    const metadata = inspectMp3(bytes);
    if (!metadata) {
      failures.push(`${item.id}: file is not a parseable MP3 stream`);
      continue;
    }
    if (metadata.durationSeconds < 2 || metadata.durationSeconds > 5) {
      failures.push(`${item.id}: parsed duration ${metadata.durationSeconds.toFixed(3)}s is outside 2–5s`);
      continue;
    }
    if (Math.abs(metadata.durationSeconds - Number(item.duration_seconds)) > 0.2) {
      failures.push(`${item.id}: parsed duration ${metadata.durationSeconds.toFixed(3)}s does not match manifest ${item.duration_seconds}s`);
      continue;
    }
    const hash = await sha256(filePath);
    if (hash !== item.sha256) failures.push(`${item.id}: SHA-256 mismatch (manifest ${item.sha256}, file ${hash})`);
  }
  if (failures.length) throw new Error(`sound file validation failed:\n${failures.join("\n")}`);
  console.log(`Validated ${manifest.length} manifest records and local MP3 files from ${manifestPath}`);
}

function insertSQL(manifest) {
  const now = new Date().toISOString();
  const statements = manifest.map(item => `INSERT INTO pet_translator_sounds (id, library_version, species, emotion, intensity, vocalization, storage_key, duration_seconds, mime_type, source_url, source_title, source_author, source_license, source_license_url, downloaded_at, sha256, review_status, created_at, updated_at) VALUES (${sqlString(item.id)}, ${sqlString(item.library_version)}, ${sqlString(item.species)}, ${sqlString(item.emotion)}, ${sqlString(item.intensity)}, ${sqlString(item.vocalization)}, ${sqlString(item.storage_key)}, ${item.duration_seconds}, ${sqlString(item.mime_type)}, ${sqlString(item.source_url)}, ${sqlString(item.source_title)}, ${sqlString(item.source_author)}, ${sqlString(item.source_license)}, ${sqlString(item.source_license_url)}, ${sqlString(item.downloaded_at)}, ${sqlString(item.sha256)}, ${sqlString(item.review_status)}, ${sqlString(now)}, ${sqlString(now)}) ON CONFLICT(id) DO UPDATE SET library_version=excluded.library_version, species=excluded.species, emotion=excluded.emotion, intensity=excluded.intensity, vocalization=excluded.vocalization, storage_key=excluded.storage_key, duration_seconds=excluded.duration_seconds, mime_type=excluded.mime_type, source_url=excluded.source_url, source_title=excluded.source_title, source_author=excluded.source_author, source_license=excluded.source_license, source_license_url=excluded.source_license_url, downloaded_at=excluded.downloaded_at, sha256=excluded.sha256, review_status=excluded.review_status, updated_at=excluded.updated_at;`);
  return `${statements.join("\n")}\n`;
}

async function upload(manifest, localMode) {
  const bucket = argument("--bucket", process.env.PET_TRANSLATOR_BUCKET_NAME || "ai-pet-studio-assets");
  const db = argument("--database", process.env.PET_TRANSLATOR_DB_NAME || "ai-pet-studio-db");
  const config = argument("--config", "wrangler.jsonc");
  const prefix = localMode ? ["--local"] : ["--remote"];
  for (const item of manifest) {
    const relativePath = item.storage_key.replace(/^pet-translator\/library\/v1\//, "");
    const filePath = join(projectDirectory, "assets/pet-translator/library/v1", relativePath);
    await run("npx", ["wrangler", "r2", "object", "put", `${bucket}/${item.storage_key}`, "--file", filePath, "--content-type", "audio/mpeg", "--config", config, ...prefix]);
  }
  const sqlPath = join(process.env.TMPDIR || "/private/tmp", `pet-translator-sounds-${Date.now()}.sql`);
  await writeFile(sqlPath, insertSQL(manifest), "utf8");
  try {
    await run("npx", ["wrangler", "d1", "execute", db, "--file", sqlPath, "--config", config, ...prefix]);
  } finally {
    // The SQL file is temporary and intentionally not placed in the repository.
    try { await unlink(sqlPath); } catch { /* already gone */ }
  }
  console.log(`Imported ${manifest.length} sounds into ${bucket} and ${db}`);
}

async function main() {
  const manifestPath = resolve(projectDirectory, argument("--manifest", defaultManifest));
  const manifest = await readManifest(manifestPath);
  await validateFiles(manifest, manifestPath);
  if (hasArgument("--sql-out")) {
    const sqlPath = resolve(projectDirectory, argument("--sql-out"));
    await writeFile(sqlPath, insertSQL(manifest), "utf8");
    console.log(`Wrote ${sqlPath}`);
  }
  if (hasArgument("--upload")) await upload(manifest, hasArgument("--local"));
  const approved = manifest.filter(item => item.review_status === "approved").length;
  console.log(`Review status: ${approved} approved, ${manifest.length - approved} pending/rejected. Set PET_TRANSLATOR_AUDIO_LIBRARY_READY=true only after the approved count reaches the configured minimum.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
