import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";
import { test } from "node:test";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function wavBytes(seconds = 1, sampleRate = 8000, channels = 1) {
  const sampleCount = Math.floor(seconds * sampleRate);
  const dataSize = sampleCount * channels * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (offset, value) => bytes.set(String(value).split("").map(char => char.charCodeAt(0)), offset);
  const writeU32 = (offset, value) => view.setUint32(offset, value, true);
  const writeU16 = (offset, value) => view.setUint16(offset, value, true);
  write(0, "RIFF"); writeU32(4, 36 + dataSize); write(8, "WAVE"); write(12, "fmt "); writeU32(16, 16);
  writeU16(20, 1); writeU16(22, channels); writeU32(24, sampleRate); writeU32(28, sampleRate * channels * 2);
  writeU16(32, channels * 2); writeU16(34, 16); write(36, "data"); writeU32(40, dataSize);
  return bytes;
}

const directory = await mkdtemp(join(tmpdir(), "ai-pet-studio-translator-"));
const bundlePath = join(directory, "pet-translator.mjs");
const libraryBundlePath = join(directory, "pet-sound-library.mjs");
const workerBundlePath = join(directory, "worker.mjs");

try {
  await build({
    entryPoints: [join(process.cwd(), "src/petTranslator.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "neutral",
    target: "es2022",
    logLevel: "silent"
  });
  const translator = await import(pathToFileURL(bundlePath).href);
  await build({
    entryPoints: [join(process.cwd(), "src/petSoundLibrary.ts")],
    bundle: true,
    format: "esm",
    outfile: libraryBundlePath,
    platform: "neutral",
    target: "es2022",
    logLevel: "silent"
  });
  const soundLibrary = await import(pathToFileURL(libraryBundlePath).href);
  await build({
    entryPoints: [join(process.cwd(), "src/index.ts")],
    bundle: true,
    format: "esm",
    outfile: workerBundlePath,
    platform: "neutral",
    target: "es2022",
    logLevel: "silent"
  });
  const worker = await import(pathToFileURL(workerBundlePath).href);

  function mp3Bytes(frameCount = 3) {
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    return Uint8Array.from({ length: frameCount * frame.length }, (_, index) => frame[index % frame.length]);
  }

  function aacBytes(frameCount = 3) {
    const frame = new Uint8Array(100);
    frame.set([0xff, 0xf1, 0x50, 0x80, 0x0c, 0x9f, 0xfc]);
    return Uint8Array.from({ length: frameCount * frame.length }, (_, index) => frame[index % frame.length]);
  }

  function m4aBytes(seconds = 1, channels = 2, sampleRate = 44100) {
    const atom = (type, size) => {
      const bytes = new Uint8Array(size);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, size);
      bytes.set([...type].map(char => char.charCodeAt(0)), 4);
      return { bytes, view };
    };
    const ftyp = atom("ftyp", 20);
    ftyp.bytes.set([..."M4A "].map(char => char.charCodeAt(0)), 8);
    ftyp.bytes.set([..."isom"].map(char => char.charCodeAt(0)), 16);
    const hdlr = atom("hdlr", 24);
    hdlr.bytes.set([..."soun"].map(char => char.charCodeAt(0)), 16);
    const mp4a = atom("mp4a", 36);
    mp4a.view.setUint16(24, channels);
    mp4a.view.setUint32(32, sampleRate << 16);
    const mvhd = atom("mvhd", 32);
    mvhd.view.setUint32(20, 1000);
    mvhd.view.setUint32(24, Math.round(seconds * 1000));
    const bytes = new Uint8Array(ftyp.bytes.length + hdlr.bytes.length + mp4a.bytes.length + mvhd.bytes.length);
    let offset = 0;
    for (const part of [ftyp, hdlr, mp4a, mvhd]) { bytes.set(part.bytes, offset); offset += part.bytes.length; }
    return bytes;
  }

  await test("accepts a real WAV header and enforces the duration limit", () => {
    const metadata = translator.inspectAudio(wavBytes(1), "audio/m4a", 15, 10 * 1024 * 1024);
    assert.equal(metadata.format, "wav");
    assert.equal(metadata.channels, 1);
    assert.ok(Math.abs(metadata.durationSeconds - 1) < 0.01);
    assert.throws(() => translator.inspectAudio(wavBytes(16), "audio/wav", 15, 10 * 1024 * 1024), error => error.code === "PET_TRANSLATOR_003");
  });

  await test("inspects an M4A audio track from MP4 atoms", () => {
    const metadata = translator.inspectAudio(m4aBytes(), "audio/m4a");
    assert.equal(metadata.format, "m4a");
    assert.equal(metadata.channels, 2);
    assert.equal(metadata.sampleRate, 44100);
    assert.ok(Math.abs(metadata.durationSeconds - 1) < 0.01);
  });

  await test("sniffs MP3 and ADTS AAC frame headers", () => {
    assert.equal(translator.inspectAudio(mp3Bytes(), "application/octet-stream").format, "mp3");
    assert.equal(translator.inspectAudio(aacBytes(), "audio/aac").format, "aac");
  });

  await test("rejects empty, non-audio, and oversized input", () => {
    assert.throws(() => translator.inspectAudio(new Uint8Array(), "audio/wav"), error => error.code === "PET_TRANSLATOR_001");
    assert.throws(() => translator.inspectAudio(new Uint8Array([1, 2, 3]), "audio/wav"), error => error.code === "PET_TRANSLATOR_004");
    assert.throws(() => translator.inspectAudio(wavBytes(1), "audio/wav", 15, 10), error => error.code === "PET_TRANSLATOR_002");
  });

  await test("validates species, language, and UUID request IDs", () => {
    assert.equal(translator.validateSpecies("CAT"), "cat");
    assert.equal(translator.validateLanguage(undefined), "zh-CN");
    assert.equal(translator.validateRequestID("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
    assert.throws(() => translator.validateSpecies("rabbit"), error => error.code === "PET_TRANSLATOR_005");
    assert.throws(() => translator.validateLanguage("en-US"), error => error.code === "PET_TRANSLATOR_006");
    assert.throws(() => translator.validateRequestID("not-a-uuid"), error => error.code === "PET_TRANSLATOR_007");
  });

  await test("normalizes valid and invalid structured model output", () => {
    const validPet = translator.normalizePetToHuman({ is_valid: true, emotion: "兴奋", intent: "寻求关注", translation: "看看我嘛", confidence: "medium", explanation: "叫声连续" });
    assert.equal(validPet.is_valid, true);
    const invalidHuman = translator.normalizeHumanToPet({ is_valid: false, transcript: null, meaning: null, emotion: null, intensity: "high" });
    assert.equal(invalidHuman.intensity, "low");
    const validHuman = translator.normalizeHumanToPet({ is_valid: true, transcript: "回来啦", meaning: "开心地打招呼", emotion: "开心", intensity: "medium" });
    assert.equal(validHuman.emotion, "happy");
    assert.throws(() => translator.normalizeHumanToPet({ is_valid: true, transcript: "x", meaning: "x", emotion: "unknown", intensity: "medium" }), error => error.code === "PET_TRANSLATOR_202");
    assert.throws(() => translator.normalizeHumanToPet({ is_valid: true, intensity: "medium" }), error => error.code === "PET_TRANSLATOR_202");
  });

  await test("selects only reviewed sounds for the same species and nearest intensity", () => {
    const record = (id, species, emotion, intensity, status = "approved") => ({
      id, library_version: "v1", species, emotion, intensity, vocalization: "meow", storage_key: `pet-translator/library/v1/${species}/${emotion}/${id}.mp3`,
      duration_seconds: 3, mime_type: "audio/mpeg", source_url: "https://freesound.org/people/test/sounds/1/", source_title: "test", source_author: "test", source_license: "CC0", source_license_url: "https://creativecommons.org/publicdomain/zero/1.0/", downloaded_at: "2026-09-08", sha256: id.padEnd(64, "0"), review_status: status
    });
    const sounds = [record("a", "cat", "happy", "low"), record("b", "cat", "happy", "high"), record("c", "cat", "happy", "medium", "pending"), record("d", "dog", "happy", "high")];
    assert.equal(soundLibrary.selectPetSound(sounds, "cat", "happy", "high", "task-1").species, "cat");
    assert.equal(soundLibrary.selectPetSound(sounds, "cat", "happy", "medium", "task-1").id, "a");
    assert.equal(soundLibrary.selectPetSound(sounds, "dog", "happy", "low", "task-1").id, "d");
    assert.equal(soundLibrary.selectPetSound(sounds, "cat", "alert", "high", "task-1"), null);
  });

  await test("creates and verifies expiring signed audio URLs", async () => {
    const token = await translator.createAudioToken("a-secret-at-least-32-characters-long", "task-1", "users/u/output.mp3", 2000);
    assert.equal(await translator.verifyAudioToken("a-secret-at-least-32-characters-long", token, "task-1", "users/u/output.mp3", 1000), true);
    assert.equal(await translator.verifyAudioToken("a-secret-at-least-32-characters-long", token, "task-2", "users/u/output.mp3", 1000), false);
    assert.equal(await translator.verifyAudioToken("a-secret-at-least-32-characters-long", token, "task-1", "users/u/output.mp3", 2000), false);
  });

  await test("normalizes single byte ranges and rejects unsatisfiable ranges", () => {
    assert.deepEqual(worker.parseRangeHeader("bytes=10-19", 100), { offset: 10, length: 10 });
    assert.deepEqual(worker.parseRangeHeader("bytes=-10", 100), { offset: 90, length: 10 });
    assert.deepEqual(worker.parseRangeHeader("bytes=90-", 100), { offset: 90, length: 10 });
    assert.equal(worker.parseRangeHeader("bytes=100-101", 100), "invalid");
  });

  await test("protects translator routes with the existing session contract", async () => {
    const user = { id: "user-1", customer_id: "aipet_device-1", device_id: "device-1", welcome_bonus_granted_at: null };
    const db = {
      prepare(sql) {
        return {
          bind(...args) { this.args = args; return this; },
          async first() {
            if (sql.includes("WHERE customer_id = ?")) return null;
            if (sql.includes("FROM users WHERE id = ?")) return user;
            if (sql.includes("FROM pet_translation_tasks")) return null;
            if (sql.includes("COUNT(*)")) return { count: 0 };
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
          async all() { return { results: [] }; }
        };
      }
    };
    const env = {
      DB: db,
      APP_NAME: "AI Pet Studio",
      JWT_SECRET: "translator-test-jwt-secret-012345678901",
      ACCESS_TOKEN_TTL_SECONDS: "3600",
      APP_ATTEST_MODE: "disabled",
      REVENUECAT_PROJECT_ID: "project",
      REVENUECAT_VIRTUAL_CURRENCY_CODE: "PTS",
      REVENUECAT_API_BASE_URL: "https://revenuecat.test",
      ASSETS: { head: async () => null, get: async () => null, put: async () => {}, delete: async () => {} }
    };
    const context = { waitUntil() {}, passThroughOnException() {} };
    const bootstrapResponse = await worker.default.fetch(new Request("https://worker.test/v1/session/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: "device-1" }) }), env, context);
    assert.equal(bootstrapResponse.status, 200);
    const session = await bootstrapResponse.json();
    const audio = new Blob([wavBytes(1)], { type: "audio/wav" });
    const form = new FormData(); form.append("audio", audio, "clip.wav"); form.append("species", "cat");
    const unauthenticated = await worker.default.fetch(new Request("https://worker.test/v1/pet-translator/pet-to-human", { method: "POST", body: form }), env, context);
    assert.equal(unauthenticated.status, 401);
    const missingRequestID = await worker.default.fetch(new Request("https://worker.test/v1/pet-translator/pet-to-human", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` }, body: form }), env, context);
    assert.equal(missingRequestID.status, 422);
    const freshForm = new FormData(); freshForm.append("audio", audio, "clip.wav"); freshForm.append("species", "cat");
    const unconfigured = await worker.default.fetch(new Request("https://worker.test/v1/pet-translator/pet-to-human", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, "X-Request-ID": "550e8400-e29b-41d4-a716-446655440000" }, body: freshForm }), env, context);
    assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).error.code, "PET_TRANSLATOR_NOT_CONFIGURED");
  });

  await test("runs both directions with idempotent debit, refund-safe state, shared R2 output, and Range playback", async () => {
    const sharedSound = {
      id: "cat-happy-01", library_version: "v1", species: "cat", emotion: "happy", intensity: "low", vocalization: "soft purr or cheerful meow",
      storage_key: "pet-translator/library/v1/cat/happy/cat-happy-01.mp3", duration_seconds: 3, mime_type: "audio/mpeg", source_url: "https://freesound.org/people/test/sounds/1/", source_title: "test", source_author: "test", source_license: "CC0", source_license_url: "https://creativecommons.org/publicdomain/zero/1.0/", downloaded_at: "2026-09-08", sha256: "a".repeat(64), review_status: "approved"
    };
    const state = { user: null, userDeleted: false, tasks: [], ledger: [], rcBalance: 100, output: new Map([[sharedSound.storage_key, mp3Bytes(3)]]), geminiCalls: 0, soundCalls: 0, sounds: [sharedSound] };
    const db = {
      prepare(sql) {
        const statement = {
          args: [],
          bind(...args) { this.args = args; return this; },
          async first() {
            if (sql.includes("FROM users WHERE customer_id = ?")) return state.user;
            if (sql.includes("FROM users WHERE id = ?")) return state.userDeleted ? null : state.user;
            if (sql.includes("FROM pet_translation_tasks") && sql.includes("request_id = ?")) return state.tasks.find(task => task.user_id === this.args[0] && task.request_id === this.args[1]) || null;
            if (sql.includes("FROM pet_translation_tasks") && sql.includes("id = ?") && !sql.includes("JOIN users")) return state.tasks.find(task => task.id === this.args[0] && task.user_id === this.args[1]) || null;
            if (sql.includes("JOIN users") && sql.includes("state = 'succeeded'")) {
              const task = state.tasks.find(item => item.id === this.args[0] && item.state === "succeeded");
              return task ? { ...task, deleted_at: state.userDeleted ? "deleted" : null } : null;
            }
            if (sql.includes("COUNT(*) AS count FROM pet_translator_sounds")) return { count: state.sounds.filter(sound => sound.library_version === this.args[0] && sound.review_status === "approved").length };
            if (sql.includes("FROM pet_translator_sounds") && sql.includes("storage_key")) return state.sounds.find(sound => sound.id === this.args[0] && sound.library_version === this.args[1] && sound.review_status === "approved") || null;
            if (sql.includes("COUNT(*)")) return { count: state.tasks.filter(task => task.created_at >= this.args[1]).length };
            if (sql.includes("state IN ('reserved', 'processing')")) return state.tasks.find(task => task.user_id === this.args[0] && ["reserved", "processing"].includes(task.state)) || null;
            if (sql.includes("FROM credit_ledger WHERE reference = ?")) return state.ledger.find(entry => entry.reference === this.args[0]) || null;
            if (sql.includes("FROM pending_refunds")) return null;
            if (sql.includes("FROM revenuecat_webhook_events")) return null;
            return null;
          },
          async all() {
            if (sql.includes("FROM pending_refunds")) return { results: [] };
            if (sql.includes("FROM pet_translator_sounds")) return { results: state.sounds.filter(sound => sound.library_version === this.args[0] && sound.species === this.args[1] && sound.emotion === this.args[2] && sound.review_status === "approved") };
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO users")) {
              state.user = { id: this.args[0], customer_id: this.args[1], device_id: this.args[2], welcome_bonus_granted_at: null };
              return { meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO pet_translation_tasks")) {
              const a = this.args;
              state.tasks.push({ id: a[0], user_id: a[1], request_id: a[2], request_fingerprint: a[3], direction: a[4], species: a[5], language: a[6], state: "reserved", phase: "reserved", credit_cost: a[7], debit_key: a[8], debit_status: "pending", refund_status: "none", input_mime_type: a[9], input_size: a[10], input_duration_seconds: a[11], audio_source: a[12], result_json: null, output_key: null, error_code: null, error_message: null, created_at: a[13], updated_at: a[14], expires_at: a[15] });
              return { meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE pet_translation_tasks SET")) {
              const taskID = this.args[this.args.length - 1];
              const task = state.tasks.find(item => item.id === taskID);
              if (task) {
                const fields = [...sql.matchAll(/(state|phase|debit_status|refund_status|result_json|output_key|error_code|error_message|gemini_model|gemini_latency_ms|gemini_input_tokens|gemini_output_tokens|sound_model|sound_latency_ms|sound_character_cost|audio_source|sound_id|sound_library_version|sound_emotion|sound_intensity|sound_duration_seconds|updated_at) = \?/g)].map(match => match[1]);
                fields.forEach((field, index) => { task[field] = this.args[index]; });
              }
              return { meta: { changes: task ? 1 : 0 } };
            }
            if (sql.includes("credit_ledger") && sql.includes("INSERT")) {
              const a = this.args;
              const generation = sql.includes("'generation_debit'");
              const refund = sql.includes("'generation_refund'");
              const reason = generation ? "generation_debit" : refund ? "generation_refund" : a[4];
              const reference = generation || refund ? a[4] : a[5];
              const created = generation || refund ? a[5] : a[6];
              if (!state.ledger.some(entry => entry.reference === reference)) state.ledger.push({ id: a[0], user_id: a[1], customer_id: a[2], amount: a[3], reason, reference, created_at: created });
              return { meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE users SET welcome_bonus_granted_at")) {
              if (state.user) state.user.welcome_bonus_granted_at = this.args[0];
              return { meta: { changes: 1 } };
            }
            if (sql.includes("INSERT OR IGNORE INTO pending_refunds")) return { meta: { changes: 1 } };
            if (sql.includes("UPDATE pending_refunds")) return { meta: { changes: 1 } };
            return { meta: { changes: 1 } };
          }
        };
        return statement;
      }
    };
    const assets = {
      async head(key) { const bytes = state.output.get(key); return bytes ? { size: bytes.length, httpMetadata: { contentType: "audio/mpeg" } } : null; },
      async get(key, options) {
        const bytes = state.output.get(key); if (!bytes) return null;
        const offset = options?.range?.offset || 0; const length = options?.range?.length ?? bytes.length - offset;
        return { body: new Response(bytes.slice(offset, offset + length)).body, size: length, httpMetadata: { contentType: "audio/mpeg" } };
      },
      async put(key, value) { state.output.set(key, new Uint8Array(value)); },
      async delete(key) { state.output.delete(key); }
    };
    const env = { DB: db, ASSETS: assets, APP_NAME: "AI Pet Studio", JWT_SECRET: "translator-test-jwt-secret-012345678901", ACCESS_TOKEN_TTL_SECONDS: "3600", APP_ATTEST_MODE: "disabled", REVENUECAT_PROJECT_ID: "project", REVENUECAT_VIRTUAL_CURRENCY_CODE: "PTS", REVENUECAT_API_BASE_URL: "https://revenuecat.test", REVENUECAT_SECRET_KEY: "rc-secret", GEMINI_API_KEY: "gemini-secret", GEMINI_BASE_URL: "https://gemini.test/v1beta", PET_TRANSLATOR_PET_TO_HUMAN_CREDIT_COST: "10", PET_TRANSLATOR_HUMAN_TO_PET_CREDIT_COST: "20", PET_TRANSLATOR_AUDIO_LIBRARY_READY: "true", PET_TRANSLATOR_SOUND_LIBRARY_VERSION: "v1", PET_TRANSLATOR_SOUND_LIBRARY_MIN_APPROVED: "1" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("revenuecat.test")) {
        if (url.includes("/transactions")) {
          const amount = Number(Object.values(JSON.parse(init.body).adjustments)[0]); state.rcBalance += amount;
          return new Response(JSON.stringify({ items: [{ currency_code: "PTS", balance: state.rcBalance }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ items: [{ currency_code: "PTS", balance: state.rcBalance }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("interactions")) {
        state.geminiCalls += 1;
        const human = JSON.parse(init.body).system_instruction.includes("semantic audio");
        const result = human
          ? { is_valid: true, transcript: "宝宝我回来啦", meaning: "开心地向宠物打招呼", emotion: "happy", intensity: "medium" }
          : { is_valid: true, emotion: "兴奋", intent: "寻求关注", translation: "看看我嘛", confidence: "medium", explanation: "叫声清晰" };
        return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify(result), usage: { total_input_tokens: 10, total_output_tokens: 8 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      state.soundCalls += 1;
      return new Response(mp3Bytes(3), { status: 200, headers: { "content-type": "audio/mpeg" } });
    };
    const context = { waitUntil() {}, passThroughOnException() {} };
    const boot = await worker.default.fetch(new Request("https://worker.test/v1/session/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: "device-1" }) }), env, context);
    const session = await boot.json();
    const makeRequest = (path, requestID, bytes, species = "cat") => { const form = new FormData(); form.append("audio", new Blob([bytes], { type: "audio/wav" }), "clip.wav"); form.append("species", species); return new Request(`https://worker.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, "X-Request-ID": requestID }, body: form }); };
    try {
      const petRequestID = "550e8400-e29b-41d4-a716-446655440001";
      const petResponse = await worker.default.fetch(makeRequest("/v1/pet-translator/pet-to-human", petRequestID, wavBytes(1)), env, context);
      assert.equal(petResponse.status, 201);
      const petBody = await petResponse.json();
      assert.equal(petBody.data.translation, "看看我嘛");
      assert.equal(state.geminiCalls, 1);
      const repeated = await worker.default.fetch(makeRequest("/v1/pet-translator/pet-to-human", petRequestID, wavBytes(1)), env, context);
      assert.equal(repeated.status, 200);
      assert.equal(state.geminiCalls, 1);
      const conflict = await worker.default.fetch(makeRequest("/v1/pet-translator/pet-to-human", petRequestID, wavBytes(1, 16000)), env, context);
      assert.equal(conflict.status, 409);
      const humanResponse = await worker.default.fetch(makeRequest("/v1/pet-translator/human-to-pet", "550e8400-e29b-41d4-a716-446655440002", wavBytes(1)), env, context);
      assert.equal(humanResponse.status, 201);
      const humanBody = await humanResponse.json();
      assert.match(humanBody.data.audio_url, /pet-translator\/audio/);
      assert.equal(humanBody.data.sound_id, "cat-happy-01");
      assert.equal(humanBody.data.sound_library_version, "v1");
      assert.equal(state.soundCalls, 0);
      const audioURL = new URL(humanBody.data.audio_url);
      const ranged = await worker.default.fetch(new Request(audioURL, { headers: { Range: "bytes=0-9" } }), env, context);
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get("content-range"), "bytes 0-9/1251");
      const balanceBeforeInvalid = state.rcBalance;
      const geminiBeforeInvalid = state.geminiCalls;
      const soundBeforeInvalid = state.soundCalls;
      const providerFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input).includes("interactions")) {
          state.geminiCalls += 1;
          return new Response(JSON.stringify({
            status: "completed",
            output_text: JSON.stringify({ is_valid: false, transcript: null, meaning: null, emotion: null, intensity: "low" })
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return providerFetch(input, init);
      };
      try {
        const invalidResponse = await worker.default.fetch(makeRequest("/v1/pet-translator/human-to-pet", "550e8400-e29b-41d4-a716-446655440003", wavBytes(1)), env, context);
        assert.equal(invalidResponse.status, 201);
        assert.equal((await invalidResponse.json()).data.is_valid, false);
        assert.equal(state.rcBalance, balanceBeforeInvalid);
        assert.equal(state.geminiCalls, geminiBeforeInvalid + 1);
        assert.equal(state.soundCalls, soundBeforeInvalid);
      } finally {
        globalThis.fetch = providerFetch;
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("uses the Gemini Interactions API with the fixed human-to-pet schema", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).includes("interactions")) {
        return new Response(JSON.stringify({
          status: "completed",
          output_text: JSON.stringify({ is_valid: true, emotion: "开心", intent: "打招呼", translation: "你好呀", confidence: "medium", explanation: "声音清晰" }),
          usage: { total_input_tokens: 12, total_output_tokens: 8 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("Unexpected non-Gemini provider call");
    };
    try {
      const env = { GEMINI_API_KEY: "gemini-test", GEMINI_BASE_URL: "https://gemini.test/v1beta", GEMINI_MODEL: "gemini-3.8-flash" };
      const analysis = await translator.analyzeAudioWithGemini(env, "PET_TO_HUMAN", "cat", "zh-CN", wavBytes(1), "audio/wav", Date.now() + 10_000);
      assert.equal(analysis.result.translation, "你好呀");
      assert.match(calls[0].init.headers["x-goog-api-key"], /gemini-test/);
      assert.equal(JSON.parse(calls[0].init.body).input[1].type, "audio");
      assert.ok(JSON.parse(calls[0].init.body).response_format.schema.additionalProperties === false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("disables translation when price or required provider is missing", () => {
    const base = { PET_TRANSLATOR_PET_TO_HUMAN_CREDIT_COST: "10", PET_TRANSLATOR_HUMAN_TO_PET_CREDIT_COST: "20", REVENUECAT_SECRET_KEY: "rc", GEMINI_API_KEY: "gemini", PET_TRANSLATOR_AUDIO_LIBRARY_READY: "true" };
    assert.equal(translator.translationConfig({ ...base, PET_TRANSLATOR_PET_TO_HUMAN_CREDIT_COST: "" }, "PET_TO_HUMAN").enabled, false);
    assert.equal(translator.translationConfig({ ...base, PET_TRANSLATOR_AUDIO_LIBRARY_READY: "false" }, "HUMAN_TO_PET").enabled, false);
    assert.equal(translator.translationConfig({ ...base, PET_TRANSLATOR_AUDIO_LIBRARY_READY: "true" }, "HUMAN_TO_PET").enabled, true);
    assert.equal(translator.translationConfig(base, "PET_TO_HUMAN").cost, 10);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
