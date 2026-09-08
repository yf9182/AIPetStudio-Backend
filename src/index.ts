import {
  AudioValidationError,
  TranslationProviderError,
  analyzeAudioWithGemini,
  createAudioToken,
  hashAudio,
  inspectAudio,
  translationConfig,
  validateLanguage,
  validateRequestID,
  validateSpecies,
  verifyAudioToken,
  type HumanToPetResult,
  type PetToHumanResult,
  type Species,
  type TranslationDirection
} from "./petTranslator";
import {
  PET_SOUND_EMOTIONS,
  PET_SOUND_LIBRARY_VERSION,
  selectPetSound,
  type PetSoundEmotion,
  type PetSoundIntensity,
  type PetSoundRecord
} from "./petSoundLibrary";

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  APP_NAME: string;
  REVENUECAT_PROJECT_ID: string;
  REVENUECAT_VIRTUAL_CURRENCY_CODE: string;
  REVENUECAT_API_BASE_URL: string;
  REVENUECAT_SECRET_KEY?: string;
  REVENUECAT_V1_SECRET_KEY?: string;
  REVENUECAT_WEBHOOK_SIGNING_SECRET?: string;
  REVENUECAT_WEBHOOK_AUTH?: string;
  JWT_SECRET?: string;
  ACCESS_TOKEN_TTL_SECONDS: string;
  DOWNLOAD_URL_TTL_SECONDS: string;
  APP_ATTEST_MODE?: string;
  APP_CHECK_PROJECT_NUMBER?: string;
  APP_CHECK_APP_ID?: string;
  CORS_ORIGINS?: string;
  VIDU_API_KEY?: string;
  VIDU_BASE_URL?: string;
  VIDU_IMAGE_MODEL?: string;
  VIDU_VIDEO_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_BASE_URL?: string;
  GEMINI_MODEL?: string;
  PET_TRANSLATOR_MAX_AUDIO_SECONDS?: string;
  PET_TRANSLATOR_MAX_FILE_MB?: string;
  PET_TRANSLATOR_PET_TO_HUMAN_CREDIT_COST?: string;
  PET_TRANSLATOR_HUMAN_TO_PET_CREDIT_COST?: string;
  PET_TRANSLATOR_RESULT_TTL_DAYS?: string;
  PET_TRANSLATOR_AUDIO_URL_TTL_SECONDS?: string;
  PET_TRANSLATOR_AUDIO_LIBRARY_READY?: string;
  PET_TRANSLATOR_SOUND_LIBRARY_VERSION?: string;
  PET_TRANSLATOR_SOUND_LIBRARY_MIN_APPROVED?: string;
}

export type User = { id: string; customer_id: string; device_id: string; welcome_bonus_granted_at?: string | null };
type MaterialSnapshot = {
  material_id: string;
  title: string;
  kind: "image" | "video";
  prompt: string;
  image_count: number;
  source_updated_at: string | null;
};

const GENERATION_COSTS = { image: 10, video: 50 } as const;

type RevenueCatBalance = { currency_code?: string; balance?: number };
type RevenueCatResponse = { items?: unknown; type?: unknown; message?: unknown };

class RevenueCatRequestError extends Error {
  readonly status: number;
  readonly providerMessage: string | null;

  constructor(status: number, providerMessage: string | null) {
    super(`RevenueCat request failed (${status})`);
    this.name = "RevenueCatRequestError";
    this.status = status;
    this.providerMessage = providerMessage;
  }
}

function now(): string { return new Date().toISOString(); }
function id(): string { return crypto.randomUUID(); }
function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) }
  });
}
function error(message: string, status = 400, code = "BAD_REQUEST"): Response {
  return json({ error: { code, message } }, { status });
}
function base64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return btoa(output).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function base64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let output = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(output);
}
function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

let appCheckKeyCache: { expiresAt: number; keys: Map<string, CryptoKey> } | null = null;
async function appCheckKeys(): Promise<Map<string, CryptoKey>> {
  if (appCheckKeyCache && appCheckKeyCache.expiresAt > Date.now()) return appCheckKeyCache.keys;
  const response = await fetch("https://firebaseappcheck.googleapis.com/v1/jwks", {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 21_600, cacheEverything: true }
  });
  if (!response.ok) throw new Error(`App Check JWKS request failed (${response.status})`);
  const body = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys || []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(jwk.kid, key);
  }
  appCheckKeyCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, keys };
  return keys;
}

async function verifyAppCheck(env: Env, request: Request): Promise<boolean> {
  const mode = String(env.APP_ATTEST_MODE || "disabled").toLowerCase();
  if (mode === "disabled" || mode === "off" || mode === "") return true;
  const token = request.headers.get("X-Firebase-AppCheck") || request.headers.get("X-App-Attest") || "";
  if (!token) return false;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(encodedHeader))) as { alg?: string; typ?: string; kid?: string };
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(encodedPayload))) as { iss?: string; aud?: unknown; exp?: number; sub?: string };
    const projectNumber = String(env.APP_CHECK_PROJECT_NUMBER || "");
    const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [];
    if (header.alg !== "RS256" || header.typ !== "JWT" || !header.kid || !projectNumber) return false;
    if (payload.iss !== `https://firebaseappcheck.googleapis.com/${projectNumber}`) return false;
    if (!audience.includes(`projects/${projectNumber}`)) return false;
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return false;
    if (env.APP_CHECK_APP_ID && payload.sub !== env.APP_CHECK_APP_ID) return false;
    const key = (await appCheckKeys()).get(header.kid);
    if (!key) return false;
    return await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      fromBase64url(encodedSignature) as unknown as BufferSource,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
  } catch (cause) {
    console.error("App Check verification failed", cause);
    return false;
  }
}
async function hmacKey(env: Env): Promise<CryptoKey> {
  if (!env.JWT_SECRET || env.JWT_SECRET.trim().length < 32) {
    throw new Error("JWT_SECRET is not configured");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function issueToken(env: Env, user: User): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + Number(env.ACCESS_TOKEN_TTL_SECONDS || 3600);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ sub: user.id, customer_id: user.customer_id, exp, iat: Math.floor(Date.now() / 1000) }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}
async function verifyToken(env: Env, token: string): Promise<{ sub: string } | null> {
  try {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return null;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromBase64url(signature) as unknown as BufferSource, new TextEncoder().encode(`${header}.${payload}`));
    if (!valid) return null;
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { sub?: string; exp?: number };
    if (!decoded.sub || !decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: decoded.sub };
  } catch { return null; }
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try { return await request.json() as Record<string, unknown>; } catch { return {}; }
}
async function userForRequest(request: Request, env: Env): Promise<User | null> {
  const value = request.headers.get("Authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : "";
  const claims = token ? await verifyToken(env, token) : null;
  if (!claims) return null;
  return await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE id = ? AND deleted_at IS NULL").bind(claims.sub).first<User>();
}
async function ensureUser(env: Env, deviceID: string): Promise<User> {
  const customerID = `aipet_${deviceID}`;
  const existing = await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE customer_id = ?").bind(customerID).first<User>();
  if (existing) return existing;
  const user: User = { id: id(), customer_id: customerID, device_id: deviceID, welcome_bonus_granted_at: null };
  await env.DB.prepare("INSERT INTO users(id, customer_id, device_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?)").bind(user.id, user.customer_id, user.device_id, now(), now()).run();
  return user;
}
async function revenueCatAdjust(env: Env, customerID: string, amount: number, reference: string, signal?: AbortSignal): Promise<number | null> {
  if (!env.REVENUECAT_SECRET_KEY) return null;
  const endpoint = `${env.REVENUECAT_API_BASE_URL}/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID)}/customers/${encodeURIComponent(customerID)}/virtual_currencies/transactions`;
  const response = await fetch(endpoint, {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: {
      Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": reference
    },
    body: JSON.stringify({ adjustments: { [env.REVENUECAT_VIRTUAL_CURRENCY_CODE]: amount }, reference })
  });
  // A freshly bootstrapped anonymous user may not exist in RevenueCat until
  // the client SDK is configured. Keep the local ledger authoritative for
  // that onboarding window; later purchases are reconciled by webhook.
  if (response.status === 404) return null;
  const rawBody = await response.text();
  let body: RevenueCatResponse = {};
  try { body = rawBody ? JSON.parse(rawBody) as RevenueCatResponse : {}; } catch { /* handled below */ }
  const providerMessage = typeof body.message === "string" ? body.message : null;
  if (!response.ok) {
    console.error("RevenueCat adjustment failed", {
      status: response.status,
      type: typeof body.type === "string" ? body.type : null,
      message: providerMessage
    });
    throw new RevenueCatRequestError(response.status, providerMessage);
  }
  if (!Array.isArray(body.items)) {
    console.error("RevenueCat adjustment returned an unexpected response", { status: response.status });
    throw new Error("RevenueCat adjustment response is invalid");
  }
  return (body.items as RevenueCatBalance[])
    .find(item => item.currency_code === env.REVENUECAT_VIRTUAL_CURRENCY_CODE)?.balance ?? null;
}
async function grantPoints(env: Env, user: User, amount: number, reason: string, reference: string): Promise<number> {
  const already = await env.DB.prepare("SELECT id FROM credit_ledger WHERE reference = ?").bind(reference).first<{ id: string }>();
  if (!already) {
    const providerBalance = await revenueCatAdjust(env, user.customer_id, amount, reference);
    if (providerBalance === null) return 0;
    await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)").bind(id(), user.id, user.customer_id, amount, reason, reference, now()).run();
  }
  return await getPoints(env, user);
}
async function debitPoints(env: Env, user: User, amount: number, reference: string): Promise<number> {
  const already = await env.DB.prepare("SELECT id FROM credit_ledger WHERE reference = ?").bind(reference).first<{ id: string }>();
  if (already) return getPoints(env, user);
  const current = await getPoints(env, user);
  if (current < amount) throw new Error("INSUFFICIENT_POINTS");
  if (env.REVENUECAT_SECRET_KEY) await revenueCatAdjust(env, user.customer_id, -amount, reference);
  await env.DB.prepare("INSERT INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)").bind(id(), user.id, user.customer_id, -amount, "generation_debit", reference, now()).run();
  return current - amount;
}
async function refundPoints(env: Env, user: User, amount: number, reference: string): Promise<number> {
  const pending = await env.DB.prepare("SELECT status FROM pending_refunds WHERE reference = ?").bind(reference).first<{ status: string }>();
  if (pending?.status === "completed") return await getPoints(env, user);
  if (!pending) await env.DB.prepare("INSERT OR IGNORE INTO pending_refunds(task_id, user_id, customer_id, amount, reference, status, attempts, updated_at) VALUES(?, ?, ?, ?, ?, 'pending', 0, ?)").bind(reference.replace(/^task:(.*):refund$/, "$1"), user.id, user.customer_id, amount, reference, now()).run();
  try {
    const balance = await grantPoints(env, user, amount, "generation_refund", reference);
    await env.DB.prepare("UPDATE pending_refunds SET status = 'completed', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE reference = ?").bind(now(), reference).run();
    return balance;
  } catch (cause) {
    await env.DB.prepare("UPDATE pending_refunds SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE reference = ?").bind(String(cause instanceof Error ? cause.message : cause).slice(0, 500), now(), reference).run();
    throw cause;
  }
}
async function retryPendingRefunds(env: Env, user: User): Promise<void> {
  const rows = await env.DB.prepare("SELECT amount, reference FROM pending_refunds WHERE user_id = ? AND status = 'pending' ORDER BY updated_at LIMIT 10").bind(user.id).all<{ amount: number; reference: string }>();
  for (const row of rows.results || []) {
    try {
      const providerBalance = await revenueCatAdjust(env, user.customer_id, row.amount, row.reference);
      if (providerBalance === null) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, 'generation_refund', ?, ?)").bind(id(), user.id, user.customer_id, row.amount, row.reference, now()).run();
      await env.DB.prepare("UPDATE pending_refunds SET status = 'completed', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE reference = ?").bind(now(), row.reference).run();
    } catch (cause) {
      await env.DB.prepare("UPDATE pending_refunds SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE reference = ?").bind(String(cause instanceof Error ? cause.message : cause).slice(0, 500), now(), row.reference).run();
    }
  }
}
async function syncSignupPointsToRevenueCat(env: Env, user: User, signal?: AbortSignal): Promise<boolean> {
  if (!env.REVENUECAT_SECRET_KEY) return false;
  if (user.welcome_bonus_granted_at) return false;
  const amount = 20;
  const reference = `signup:${user.id}`;
  // The first bootstrap can happen before the RevenueCat SDK creates this
  // customer. Reusing the signup reference makes the later retry idempotent.
  const providerBalance = await revenueCatAdjust(env, user.customer_id, amount, reference, signal);
  if (providerBalance === null) return false;
  const grantedAt = now();
  await env.DB.prepare("UPDATE users SET welcome_bonus_granted_at = ?, updated_at = ? WHERE id = ? AND welcome_bonus_granted_at IS NULL")
    .bind(grantedAt, grantedAt, user.id).run();
  await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .bind(id(), user.id, user.customer_id, amount, "signup", reference, grantedAt).run();
  return true;
}
type PointsRead = { balance: number; welcomeBonusGranted: boolean };
async function revenueCatBalance(env: Env, user: User, signal?: AbortSignal): Promise<number | null> {
  const response = await fetch(`${env.REVENUECAT_API_BASE_URL}/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID)}/customers/${encodeURIComponent(user.customer_id)}/virtual_currencies`, {
    ...(signal ? { signal } : {}),
    headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` }
  });
  if (response.status === 404) return null;
  const rawBody = await response.text();
  let body: RevenueCatResponse = {};
  try { body = rawBody ? JSON.parse(rawBody) as RevenueCatResponse : {}; } catch { /* handled below */ }
  const providerMessage = typeof body.message === "string" ? body.message : null;
  if (!response.ok) {
    console.error("RevenueCat balance request failed", {
      status: response.status,
      type: typeof body.type === "string" ? body.type : null,
      message: providerMessage
    });
    throw new RevenueCatRequestError(response.status, providerMessage);
  }
  if (!Array.isArray(body.items)) {
    console.error("RevenueCat balance returned an unexpected response", { status: response.status });
    throw new Error("RevenueCat balance response is invalid");
  }
  const item = (body.items as RevenueCatBalance[]).find(entry => entry.currency_code === env.REVENUECAT_VIRTUAL_CURRENCY_CODE);
  return typeof item?.balance === "number" ? item.balance : 0;
}
async function readPoints(env: Env, user: User): Promise<PointsRead> {
  if (!env.REVENUECAT_SECRET_KEY) return { balance: 0, welcomeBonusGranted: false };
  const welcomeBonusGranted = await syncSignupPointsToRevenueCat(env, user);
  return { balance: await revenueCatBalance(env, user) ?? 0, welcomeBonusGranted };
}
async function getPoints(env: Env, user: User): Promise<number> {
  return (await readPoints(env, user)).balance;
}
async function getEntitlement(env: Env, user: User): Promise<string | null> {
  if (!env.REVENUECAT_V1_SECRET_KEY) return null;
  try {
    const endpoint = `${env.REVENUECAT_API_BASE_URL}/v1/subscribers/${encodeURIComponent(user.customer_id)}`;
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_V1_SECRET_KEY}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) throw new RevenueCatRequestError(response.status, `subscriber lookup failed (${response.status})`);
    const body = await response.json() as {
      subscriber?: {
        entitlements?: Record<string, { expires_date?: string | null; grace_period_expires_date?: string | null }>
      }
    };
    const entitlement = body.subscriber?.entitlements?.pro;
    if (!entitlement) return null;
    const expiration = entitlement.grace_period_expires_date || entitlement.expires_date;
    if (!expiration || Date.parse(expiration) > Date.now()) return "pro";
    return null;
  } catch (cause) {
    console.error("RevenueCat entitlement failed", cause);
    return null;
  }
}

function parseMaterialSnapshot(value: unknown, templateID: string | null): MaterialSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["material_id", "title", "kind", "prompt", "image_count", "source_updated_at"]);
  const unsupported = Object.keys(body).find(key => !allowed.has(key));
  if (unsupported) return null;
  // material_id is optional; when a template_id is supplied it must match the snapshot material_id.
  const materialID = body.material_id === undefined || body.material_id === null ? "" : String(body.material_id).trim();
  if (templateID && materialID !== templateID) return null;
  const title = body.title === undefined || body.title === null ? "" : String(body.title).trim();
  if (title.length > 500) return null;
  if (body.kind !== "image" && body.kind !== "video") return null;
  if (typeof body.image_count !== "number" || !Number.isSafeInteger(body.image_count) || body.image_count !== 1) return null;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const maxPromptLength = body.kind === "image" ? 2_000 : 5_000;
  if (prompt.trim().length < 1 || prompt.length > maxPromptLength) return null;
  if (body.source_updated_at !== undefined && body.source_updated_at !== null && typeof body.source_updated_at !== "string") return null;
  return {
    material_id: materialID,
    title,
    kind: body.kind,
    prompt,
    image_count: body.image_count,
    source_updated_at: body.source_updated_at === undefined || body.source_updated_at === null ? null : body.source_updated_at
  };
}

type PetTranslationTask = Record<string, any> & {
  id: string;
  user_id: string;
  request_id: string;
  request_fingerprint: string;
  direction: TranslationDirection;
  species: Species;
  language: "zh-CN";
  state: "reserved" | "processing" | "succeeded" | "failed" | "expired";
  debit_status: "pending" | "confirmed" | "unknown" | "not_required";
  refund_status: "none" | "pending" | "completed" | "manual_review";
  audio_source?: "none" | "generated" | "shared_library";
  sound_id?: string | null;
  sound_library_version?: string | null;
  sound_emotion?: PetSoundEmotion | null;
  sound_intensity?: PetSoundIntensity | null;
  sound_duration_seconds?: number | null;
};

type TranslationInput = {
  requestID: string;
  fingerprint: string;
  species: Species;
  language: "zh-CN";
  bytes: Uint8Array;
  metadata: ReturnType<typeof inspectAudio>;
};

function positiveConfigNumber(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function translationMaxSeconds(env: Env): number {
  return positiveConfigNumber(env.PET_TRANSLATOR_MAX_AUDIO_SECONDS, 15, 15);
}

function translationMaxBytes(env: Env): number {
  return Math.round(positiveConfigNumber(env.PET_TRANSLATOR_MAX_FILE_MB, 10, 10) * 1024 * 1024);
}

function translationResultTTLDays(env: Env): number {
  return positiveConfigNumber(env.PET_TRANSLATOR_RESULT_TTL_DAYS, 7, 7);
}

function translationAudioURLTTLSeconds(env: Env): number {
  return Math.round(positiveConfigNumber(env.PET_TRANSLATOR_AUDIO_URL_TTL_SECONDS, 900, 900));
}

function translationExpiry(env: Env, createdAt = Date.now()): string {
  return new Date(createdAt + translationResultTTLDays(env) * 24 * 60 * 60 * 1000).toISOString();
}

function translationSoundLibraryVersion(env: Env): string {
  return env.PET_TRANSLATOR_SOUND_LIBRARY_VERSION?.trim() || PET_SOUND_LIBRARY_VERSION;
}

function translationSoundLibraryMinimum(env: Env): number {
  const parsed = Number(env.PET_TRANSLATOR_SOUND_LIBRARY_MIN_APPROVED || 80);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 80;
}

async function petSoundLibraryReady(env: Env): Promise<boolean> {
  if (env.PET_TRANSLATOR_AUDIO_LIBRARY_READY !== "true") return false;
  const version = translationSoundLibraryVersion(env);
  if (version !== PET_SOUND_LIBRARY_VERSION) return false;
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM pet_translator_sounds WHERE library_version = ? AND review_status = 'approved'")
    .bind(version).first<{ count: number }>();
  return Number(row?.count || 0) >= translationSoundLibraryMinimum(env);
}

function ensureTranslationDeadline(deadline: number, reserveMs = 250): void {
  if (Date.now() >= deadline - reserveMs) throw new TranslationProviderError("PET_TRANSLATOR_TIMEOUT", "translation request timed out", 504, true);
}

async function readTranslationInput(request: Request, env: Env, direction: TranslationDirection): Promise<TranslationInput> {
  const requestID = validateRequestID(request.headers.get("X-Request-ID"));
  const maxBytes = translationMaxBytes(env);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  // Multipart overhead is allowed, while an obviously oversized body is
  // rejected before form parsing allocates it in the Worker.
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes + 1_048_576) {
    throw new AudioValidationError("PET_TRANSLATOR_002", "audio is too large", 413);
  }
  let form: FormData;
  try { form = await request.formData(); }
  catch { throw new AudioValidationError("PET_TRANSLATOR_001", "a multipart audio request is required", 422); }
  const unsupported = [...form.keys()].find(key => !["audio", "species", "language"].includes(key));
  if (unsupported) throw new AudioValidationError("PET_TRANSLATOR_008", `unsupported field: ${unsupported}`, 422);
  if (form.getAll("audio").length !== 1 || form.getAll("species").length !== 1 || form.getAll("language").length > 1) {
    throw new AudioValidationError("PET_TRANSLATOR_008", "audio, species and language may only be supplied once", 422);
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) throw new AudioValidationError("PET_TRANSLATOR_001", "audio is required", 422);
  const species = validateSpecies(form.get("species"));
  const language = validateLanguage(form.get("language"));
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const metadata = inspectAudio(bytes, audio.type, translationMaxSeconds(env), maxBytes);
  const fingerprint = `${direction}:${species}:${language}:${await hashAudio(bytes)}`;
  return { requestID, fingerprint, species, language, bytes, metadata };
}

async function loadTranslationTask(env: Env, userID: string, taskID: string): Promise<PetTranslationTask | null> {
  return await env.DB.prepare("SELECT * FROM pet_translation_tasks WHERE id = ? AND user_id = ?").bind(taskID, userID).first<PetTranslationTask>();
}

async function loadTranslationTaskByRequest(env: Env, userID: string, requestID: string): Promise<PetTranslationTask | null> {
  return await env.DB.prepare("SELECT * FROM pet_translation_tasks WHERE user_id = ? AND request_id = ?").bind(userID, requestID).first<PetTranslationTask>();
}

async function updateTranslationTask(env: Env, taskID: string, values: Record<string, unknown>): Promise<void> {
  const allowed = new Set([
    "state", "phase", "debit_status", "refund_status", "result_json", "output_key", "error_code", "error_message",
    "gemini_model", "gemini_latency_ms", "gemini_input_tokens", "gemini_output_tokens", "sound_model", "sound_latency_ms", "sound_character_cost",
    "audio_source", "sound_id", "sound_library_version", "sound_emotion", "sound_intensity", "sound_duration_seconds", "updated_at"
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
  const bindings = entries.map(([, value]) => value === undefined ? null : value);
  await env.DB.prepare(`UPDATE pet_translation_tasks SET ${assignments} WHERE id = ?`).bind(...bindings, taskID).run();
}

function parseTranslationResult(task: PetTranslationTask): Record<string, unknown> {
  if (typeof task.result_json !== "string" || !task.result_json) return {};
  try {
    const result = JSON.parse(task.result_json) as unknown;
    return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  } catch { return {}; }
}

async function translationAudioStorageKey(env: Env, task: PetTranslationTask): Promise<string | null> {
  if (task.state !== "succeeded") return null;
  if (task.audio_source === "shared_library") {
    if (!task.sound_id || !task.sound_library_version) return null;
    const sound = await env.DB.prepare("SELECT storage_key FROM pet_translator_sounds WHERE id = ? AND library_version = ? AND review_status = 'approved'")
      .bind(task.sound_id, task.sound_library_version).first<{ storage_key: string }>();
    return sound?.storage_key || null;
  }
  return task.output_key || null;
}

async function translationAudioURL(request: Request, env: Env, task: PetTranslationTask): Promise<string | null> {
  const storageKey = await translationAudioStorageKey(env, task);
  if (!storageKey || !env.JWT_SECRET?.trim()) return null;
  const expiresAt = Math.floor(Date.parse(task.expires_at) / 1000);
  const expires = Math.min(expiresAt, Math.floor(Date.now() / 1000) + translationAudioURLTTLSeconds(env));
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return null;
  const token = await createAudioToken(env.JWT_SECRET.trim(), task.id, storageKey, expires);
  return `${new URL(request.url).origin}/v1/pet-translator/audio/${encodeURIComponent(task.id)}?token=${encodeURIComponent(token)}`;
}

async function translationData(request: Request, env: Env, task: PetTranslationTask): Promise<Record<string, unknown>> {
  const result = task.state === "expired" ? {} : parseTranslationResult(task);
  const soundID = task.state === "expired" ? null : task.sound_id || null;
  const soundEmotion = task.state === "expired" ? null : task.sound_emotion || null;
  const soundIntensity = task.state === "expired" ? null : task.sound_intensity || null;
  const soundDuration = task.state === "expired" ? null : task.sound_duration_seconds ?? null;
  const soundLibraryVersion = task.state === "expired" ? null : task.sound_library_version || null;
  return {
    task_id: task.id,
    direction: task.direction,
    species: task.species,
    language: task.language,
    state: task.state,
    phase: task.phase,
    is_valid: typeof result.is_valid === "boolean" ? result.is_valid : null,
    emotion: result.emotion ?? null,
    intent: result.intent ?? null,
    translation: result.translation ?? null,
    confidence: result.confidence ?? null,
    explanation: result.explanation ?? null,
    transcript: result.transcript ?? null,
    meaning: result.meaning ?? null,
    intensity: result.intensity ?? null,
    audio_url: await translationAudioURL(request, env, task),
    sound_id: soundID,
    sound_emotion: soundEmotion,
    sound_intensity: soundIntensity,
    audio_duration_seconds: soundDuration,
    sound_library_version: soundLibraryVersion,
    credit_cost: task.credit_cost,
    debit_status: task.debit_status,
    refund_status: task.refund_status,
    error_code: task.error_code || null,
    error_message: task.error_message || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    expires_at: task.expires_at
  };
}

function translationEnvelope(data: Record<string, unknown>): Record<string, unknown> {
  return { code: 0, message: "success", data };
}

function translatorError(env: Env, message: string, status = 400, code = "BAD_REQUEST"): Response {
  return json({ error: { code, message } }, { status, headers: { ...corsHeaders(env), "cache-control": "no-store" } });
}

function translationErrorWithTask(env: Env, taskID: string, state: string, code: string, message: string, status: number): Response {
  return json({ error: { code, message }, data: { task_id: taskID, state } }, { status, headers: { ...corsHeaders(env), "cache-control": "no-store" } });
}

function translationFailureStatus(code: string | null): number {
  if (code === "PET_TRANSLATOR_101") return 402;
  if (code === "PET_TRANSLATOR_TIMEOUT") return 504;
  if (code?.endsWith("_NOT_CONFIGURED") || code === "PET_TRANSLATOR_201" || code === "PET_TRANSLATOR_301" || code === "CREDIT_DEBIT_UNKNOWN" || code === "POINTS_PROVIDER_ERROR" || code === "PET_TRANSLATOR_INTERRUPTED") return 503;
  if (code?.startsWith("PET_TRANSLATOR_2")) return 502;
  return 502;
}

async function expireTranslationTaskIfNeeded(env: Env, task: PetTranslationTask): Promise<PetTranslationTask> {
  if (task.state === "expired" || !task.expires_at || Date.parse(task.expires_at) > Date.now()) return task;
  let deleted = true;
  if (task.output_key) {
    try { await env.ASSETS.delete(task.output_key); } catch (cause) { deleted = false; console.error("Expired pet translation cleanup failed", cause); }
  }
  const outputKey = deleted ? null : task.output_key;
  await updateTranslationTask(env, task.id, {
    state: "expired",
    phase: "expired",
    result_json: null,
    output_key: outputKey,
    audio_source: "none",
    sound_id: null,
    sound_library_version: null,
    sound_emotion: null,
    sound_intensity: null,
    sound_duration_seconds: null,
    updated_at: now()
  });
  return {
    ...task,
    state: "expired",
    phase: "expired",
    result_json: null,
    output_key: outputKey,
    audio_source: "none",
    sound_id: null,
    sound_library_version: null,
    sound_emotion: null,
    sound_intensity: null,
    sound_duration_seconds: null
  };
}

async function respondWithTranslationTask(request: Request, env: Env, task: PetTranslationTask, status = 200): Promise<Response> {
  task = await expireTranslationTaskIfNeeded(env, task);
  if (task.state === "expired") return translationErrorWithTask(env, task.id, task.state, "PET_TRANSLATOR_RESULT_EXPIRED", "translation result has expired", 410);
  if (task.state === "failed") {
    return translationErrorWithTask(env, task.id, task.state, task.error_code || "PET_TRANSLATOR_500", task.error_message || "translation failed", translationFailureStatus(task.error_code || null));
  }
  return json(translationEnvelope(await translationData(request, env, task)), { status, headers: { ...corsHeaders(env), "cache-control": "no-store" } });
}

type TranslationDebitOutcome = "confirmed" | "insufficient" | "unavailable" | "unknown";

async function withRevenueCatDeadline<T>(deadline: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = Math.min(10_000, deadline - Date.now() - 250);
  if (remaining <= 0) throw new Error("POINTS_REQUEST_TIMED_OUT");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try { return await operation(controller.signal); }
  finally { clearTimeout(timer); }
}

async function debitTranslationPoints(env: Env, user: User, amount: number, reference: string, deadline: number): Promise<TranslationDebitOutcome> {
  const already = await env.DB.prepare("SELECT id FROM credit_ledger WHERE reference = ?").bind(reference).first<{ id: string }>();
  if (already) return "confirmed";
  let current: number;
  try {
    await withRevenueCatDeadline(deadline, signal => syncSignupPointsToRevenueCat(env, user, signal));
    const providerBalance = await withRevenueCatDeadline(deadline, signal => revenueCatBalance(env, user, signal));
    if (providerBalance === null) return "unavailable";
    current = providerBalance;
  }
  catch { return "unavailable"; }
  if (current < amount) return "insufficient";
  try {
    const providerBalance = await withRevenueCatDeadline(deadline, signal => revenueCatAdjust(env, user.customer_id, -amount, reference, signal));
    if (providerBalance === null) return "unavailable";
  } catch (cause) {
    if (cause instanceof RevenueCatRequestError && cause.status === 422 && /balance|enough|insufficient/i.test(cause.providerMessage || "")) return "insufficient";
    return "unknown";
  }
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, 'generation_debit', ?, ?)")
      .bind(id(), user.id, user.customer_id, -amount, reference, now()).run();
    return "confirmed";
  } catch {
    // RevenueCat has already accepted the idempotent adjustment. Do not issue
    // a refund until an operator/reconciliation pass confirms its outcome.
    return "unknown";
  }
}

async function refundTranslationPoints(env: Env, user: User, taskID: string, amount: number, deadline?: number): Promise<"completed" | "pending"> {
  const reference = `pet-translator:${taskID}:refund`;
  try {
    const existing = await env.DB.prepare("SELECT status FROM pending_refunds WHERE reference = ?").bind(reference).first<{ status: string }>();
    if (existing?.status === "completed") return "completed";
    if (!existing) await env.DB.prepare("INSERT OR IGNORE INTO pending_refunds(task_id, user_id, customer_id, amount, reference, status, attempts, updated_at) VALUES(?, ?, ?, ?, ?, 'pending', 0, ?)")
      .bind(taskID, user.id, user.customer_id, amount, reference, now()).run();
    const providerBalance = deadline === undefined
      ? await revenueCatAdjust(env, user.customer_id, amount, reference)
      : await withRevenueCatDeadline(deadline, signal => revenueCatAdjust(env, user.customer_id, amount, reference, signal));
    if (providerBalance === null) return "pending";
    await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, 'generation_refund', ?, ?)")
      .bind(id(), user.id, user.customer_id, amount, reference, now()).run();
    await env.DB.prepare("UPDATE pending_refunds SET status = 'completed', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE reference = ?")
      .bind(now(), reference).run();
    return "completed";
  } catch (cause) {
    try {
      await env.DB.prepare("UPDATE pending_refunds SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE reference = ?")
        .bind(String(cause instanceof Error ? cause.message : cause).slice(0, 500), now(), reference).run();
    } catch (recordingCause) {
      console.error("Pet translation refund state could not be recorded", { taskID, cause: recordingCause });
    }
    return "pending";
  }
}

async function failTranslationTask(env: Env, taskID: string, user: User, cost: number, code: string, message: string, debitStatus: PetTranslationTask["debit_status"], shouldRefund: boolean, deadline?: number, resultJSON?: string | null): Promise<void> {
  let refundStatus: PetTranslationTask["refund_status"] = "none";
  if (shouldRefund) refundStatus = (await refundTranslationPoints(env, user, taskID, cost, deadline)) === "completed" ? "completed" : "pending";
  const values: Record<string, unknown> = {
    state: "failed",
    phase: shouldRefund && refundStatus === "pending" ? "refund_pending" : "failed",
    debit_status: debitStatus,
    refund_status: refundStatus,
    error_code: code,
    error_message: message.slice(0, 500),
    updated_at: now()
  };
  if (resultJSON !== undefined) values.result_json = resultJSON;
  await updateTranslationTask(env, taskID, values);
}

async function processTranslationTask(env: Env, taskID: string, user: User, input: TranslationInput, direction: TranslationDirection, cost: number, ctx: ExecutionContext, deadline: number): Promise<void> {
  const startedAt = Date.now();
  const debitKey = `pet-translator:${taskID}:debit`;
  let debitStatus: PetTranslationTask["debit_status"] = "pending";
  try {
    if (Date.now() >= deadline - 250) {
      await failTranslationTask(env, taskID, user, cost, "PET_TRANSLATOR_TIMEOUT", "translation request timed out", "not_required", false, deadline);
      return;
    }
    await updateTranslationTask(env, taskID, { phase: "billing", updated_at: now() });
    const debit = await debitTranslationPoints(env, user, cost, debitKey, deadline);
    if (debit === "insufficient") {
      await failTranslationTask(env, taskID, user, cost, "PET_TRANSLATOR_101", "not enough credits", "not_required", false);
      return;
    }
    if (debit === "unavailable") {
      await failTranslationTask(env, taskID, user, cost, "POINTS_PROVIDER_ERROR", "points service is temporarily unavailable", "not_required", false);
      return;
    }
    if (debit === "unknown") {
      debitStatus = "unknown";
      await updateTranslationTask(env, taskID, { state: "failed", phase: "manual_review", debit_status: "unknown", refund_status: "manual_review", error_code: "CREDIT_DEBIT_UNKNOWN", error_message: "credit adjustment outcome requires reconciliation", updated_at: now() });
      return;
    }
    debitStatus = "confirmed";
    await updateTranslationTask(env, taskID, { state: "processing", phase: "gemini", debit_status: debitStatus, updated_at: now() });
    const analysis = await analyzeAudioWithGemini(env, direction, input.species, input.language, input.bytes, input.metadata.mimeType, deadline);
    ensureTranslationDeadline(deadline);
    await updateTranslationTask(env, taskID, {
      phase: direction === "HUMAN_TO_PET" && (analysis.result as HumanToPetResult).is_valid ? "sound_matching" : "persisting",
      gemini_model: analysis.model,
      gemini_latency_ms: analysis.latencyMs,
      gemini_input_tokens: analysis.inputTokens,
      gemini_output_tokens: analysis.outputTokens,
      updated_at: now()
    });
    if (!analysis.result.is_valid) {
      const refundStatus = (await refundTranslationPoints(env, user, taskID, cost, deadline)) === "completed" ? "completed" : "pending";
      await updateTranslationTask(env, taskID, {
        // The business result is available immediately, but keep the task in
        // processing until a pending credit refund is confirmed. This avoids
        // reporting a completed task while the user's balance is unresolved.
        state: refundStatus === "completed" ? "succeeded" : "processing",
        phase: refundStatus === "completed" ? "completed" : "refund_pending",
        result_json: JSON.stringify(analysis.result),
        refund_status: refundStatus,
        error_code: null,
        error_message: null,
        updated_at: now()
      });
      console.log("Pet translation completed", { task_id: taskID, direction, species: input.species, gemini_latency_ms: analysis.latencyMs, total_latency_ms: Date.now() - startedAt, success: true, valid_audio: false });
      return;
    }
    if (direction === "PET_TO_HUMAN") {
      await updateTranslationTask(env, taskID, { state: "succeeded", phase: "completed", result_json: JSON.stringify(analysis.result), updated_at: now() });
      console.log("Pet translation completed", { task_id: taskID, direction, species: input.species, gemini_latency_ms: analysis.latencyMs, total_latency_ms: Date.now() - startedAt, success: true, valid_audio: true });
      return;
    }
    const humanResult = analysis.result as HumanToPetResult;
    if (!humanResult.emotion || !PET_SOUND_EMOTIONS.includes(humanResult.emotion)) {
      throw new TranslationProviderError("PET_TRANSLATOR_202", "Gemini returned an unsupported emotion");
    }
    const libraryVersion = translationSoundLibraryVersion(env);
    const soundRows = await env.DB.prepare(`
      SELECT id, library_version, species, emotion, intensity, vocalization, storage_key,
             duration_seconds, mime_type, source_url, source_author, source_license,
             source_title, source_license_url, downloaded_at, sha256, review_status
      FROM pet_translator_sounds
      WHERE library_version = ? AND species = ? AND emotion = ? AND review_status = 'approved'
    `).bind(libraryVersion, input.species, humanResult.emotion).all<PetSoundRecord>();
    ensureTranslationDeadline(deadline);
    const sound = selectPetSound(soundRows.results || [], input.species, humanResult.emotion, humanResult.intensity, taskID);
    if (!sound) {
      await failTranslationTask(env, taskID, user, cost, "PET_TRANSLATOR_SOUND_UNAVAILABLE", "no reviewed pet sound is available for the detected emotion", debitStatus, true, deadline, JSON.stringify(analysis.result));
      console.log("Pet translation completed", { task_id: taskID, direction, species: input.species, gemini_latency_ms: analysis.latencyMs, total_latency_ms: Date.now() - startedAt, success: false, valid_audio: true, sound_available: false });
      return;
    }
    ensureTranslationDeadline(deadline);
    await updateTranslationTask(env, taskID, {
      state: "succeeded",
      phase: "completed",
      result_json: JSON.stringify(analysis.result),
      audio_source: "shared_library",
      output_key: null,
      sound_id: sound.id,
      sound_library_version: sound.library_version,
      sound_emotion: sound.emotion,
      sound_intensity: sound.intensity,
      sound_duration_seconds: sound.duration_seconds,
      error_code: null,
      error_message: null,
      updated_at: now()
    });
    console.log("Pet translation completed", { task_id: taskID, direction, species: input.species, gemini_latency_ms: analysis.latencyMs, sound_id: sound.id, sound_library_version: sound.library_version, total_latency_ms: Date.now() - startedAt, success: true, valid_audio: true });
  } catch (cause) {
    const provider = cause instanceof TranslationProviderError ? cause : null;
    const code = provider?.code || "PET_TRANSLATOR_500";
    const message = provider?.message || (cause instanceof Error ? cause.message : "translation failed");
    console.error("Pet translation failed", { task_id: taskID, direction, species: input.species, error_code: code, success: false });
    if (debitStatus === "confirmed") {
      await failTranslationTask(env, taskID, user, cost, code, message, debitStatus, true, deadline);
    } else {
      await updateTranslationTask(env, taskID, { state: "failed", phase: "failed", debit_status: debitStatus, refund_status: "none", error_code: code, error_message: message.slice(0, 500), updated_at: now() });
    }
  }
  void ctx;
}

async function recoverStaleTranslationTasks(env: Env, userID: string): Promise<void> {
  const reservedCutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const processingCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = await env.DB.prepare(`
    SELECT * FROM pet_translation_tasks
    WHERE user_id = ? AND ((state = 'reserved' AND updated_at < ?) OR (state = 'processing' AND updated_at < ?))
    LIMIT 10
  `).bind(userID, reservedCutoff, processingCutoff).all<PetTranslationTask>();
  for (const task of rows.results || []) {
    const debit = await env.DB.prepare("SELECT id FROM credit_ledger WHERE reference = ?").bind(task.debit_key).first<{ id: string }>();
    if (debit || task.debit_status === "confirmed") {
      const user = await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE id = ? AND deleted_at IS NULL").bind(userID).first<User>();
      if (user) await failTranslationTask(env, task.id, user, Number(task.credit_cost), "PET_TRANSLATOR_INTERRUPTED", "translation was interrupted and requires a credit refund", "confirmed", true);
      continue;
    }
    if (task.debit_status === "unknown") {
      await updateTranslationTask(env, task.id, { state: "failed", phase: "manual_review", refund_status: "manual_review", error_code: "CREDIT_DEBIT_UNKNOWN", error_message: "credit adjustment outcome requires reconciliation", updated_at: now() });
    } else {
      await updateTranslationTask(env, task.id, { state: "expired", phase: "expired", debit_status: "not_required", error_code: "PET_TRANSLATOR_INTERRUPTED", error_message: "translation request expired before processing", updated_at: now() });
    }
  }
}

async function handleTranslationRequest(request: Request, env: Env, user: User, direction: TranslationDirection, ctx: ExecutionContext): Promise<Response> {
  const deadline = Date.now() + 60_000;
  let input: TranslationInput;
  try { input = await readTranslationInput(request, env, direction); }
  catch (cause) {
    if (cause instanceof AudioValidationError) return translatorError(env, cause.message, cause.status, cause.code);
    return translatorError(env, "Invalid translation request", 422, "PET_TRANSLATOR_001");
  }
  const existing = await loadTranslationTaskByRequest(env, user.id, input.requestID);
  if (existing) {
    if (existing.request_fingerprint !== input.fingerprint) return translatorError(env, "X-Request-ID was already used for different audio", 409, "IDEMPOTENCY_KEY_REUSED");
    return respondWithTranslationTask(request, env, existing);
  }
  const config = translationConfig(env, direction);
  if (!config.enabled) return translatorError(env, "Pet translator is temporarily unavailable", 503, "PET_TRANSLATOR_NOT_CONFIGURED");
  if (direction === "HUMAN_TO_PET" && !(await petSoundLibraryReady(env))) {
    return translatorError(env, "Pet sound library is temporarily unavailable", 503, "PET_TRANSLATOR_SOUND_LIBRARY_NOT_READY");
  }
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM pet_translation_tasks WHERE user_id = ? AND created_at >= ?").bind(user.id, minuteAgo).first<{ count: number }>();
  if (Number(recent?.count || 0) >= 5) return translatorError(env, "Too many translation requests", 429, "PET_TRANSLATOR_RATE_LIMITED");
  await recoverStaleTranslationTasks(env, user.id);
  const active = await env.DB.prepare("SELECT id FROM pet_translation_tasks WHERE user_id = ? AND state IN ('reserved', 'processing') LIMIT 1").bind(user.id).first<{ id: string }>();
  if (active) return translatorError(env, "A translation is already processing", 409, "PET_TRANSLATOR_BUSY");
  const taskID = id();
  const createdAt = now();
  try {
    await env.DB.prepare(`
      INSERT INTO pet_translation_tasks(
        id, user_id, request_id, request_fingerprint, direction, species, language, state, phase,
        credit_cost, debit_key, debit_status, refund_status, input_mime_type, input_size,
        input_duration_seconds, audio_source, created_at, updated_at, expires_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'reserved', 'reserved', ?, ?, 'pending', 'none', ?, ?, ?, ?, ?, ?, ?)
    `).bind(taskID, user.id, input.requestID, input.fingerprint, direction, input.species, input.language, config.cost, `pet-translator:${taskID}:debit`, input.metadata.mimeType, input.bytes.length, input.metadata.durationSeconds, "none", createdAt, createdAt, translationExpiry(env)).run();
  } catch (cause) {
    const raced = await loadTranslationTaskByRequest(env, user.id, input.requestID);
    if (raced) {
      if (raced.request_fingerprint !== input.fingerprint) return translatorError(env, "X-Request-ID was already used for different audio", 409, "IDEMPOTENCY_KEY_REUSED");
      return respondWithTranslationTask(request, env, raced);
    }
    if (String(cause).toLowerCase().includes("unique")) return translatorError(env, "A translation is already processing", 409, "PET_TRANSLATOR_BUSY");
    throw cause;
  }
  const processing = processTranslationTask(env, taskID, user, input, direction, config.cost, ctx, deadline);
  // Keep the persisted task progressing if the client disconnects while the
  // provider calls are still in flight; the caller can recover via task GET.
  ctx.waitUntil(processing);
  await processing;
  const task = await loadTranslationTask(env, user.id, taskID);
  if (!task) return translatorError(env, "Translation task was not saved", 500, "PET_TRANSLATOR_500");
  const response = await respondWithTranslationTask(request, env, task, 201);
  return response;
}

export function parseRangeHeader(value: string | null, size: number): { offset: number; length: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return "invalid";
  let offset: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    offset = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    offset = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || offset >= size) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { offset, length: end - offset + 1 };
}

async function handleTranslationAudio(request: Request, env: Env, taskID: string): Promise<Response> {
  if (!env.JWT_SECRET?.trim() || env.JWT_SECRET.trim().length < 32) return translatorError(env, "Worker JWT_SECRET is not configured", 503, "CONFIGURATION_ERROR");
  const token = new URL(request.url).searchParams.get("token") || "";
  const task = await env.DB.prepare("SELECT t.*, u.deleted_at FROM pet_translation_tasks t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.state = 'succeeded'")
    .bind(taskID).first<PetTranslationTask & { deleted_at?: string | null }>();
  if (!task || task.deleted_at) return translatorError(env, "Audio not found", 404, "NOT_FOUND");
  const storageKey = await translationAudioStorageKey(env, task);
  if (!storageKey) return translatorError(env, "Audio not found", 404, "NOT_FOUND");
  if (Date.parse(task.expires_at) <= Date.now()) return translatorError(env, "Audio has expired", 410, "PET_TRANSLATOR_RESULT_EXPIRED");
  if (!(await verifyAudioToken(env.JWT_SECRET.trim(), token, task.id, storageKey))) return translatorError(env, "Audio URL is invalid or expired", 401, "UNAUTHORIZED");
  const head = await env.ASSETS.head(storageKey);
  if (!head) return translatorError(env, "Audio not found", 404, "NOT_FOUND");
  const range = parseRangeHeader(request.headers.get("Range"), head.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...corsHeaders(env), "content-range": `bytes */${head.size}`, "accept-ranges": "bytes" } });
  const headers: Record<string, string> = {
    ...corsHeaders(env),
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=60",
    "content-length": String(range ? range.length : head.size),
    "content-disposition": "inline"
  };
  if (range) {
    headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
    if (request.method === "HEAD") return new Response(null, { status: 206, headers });
    const object = await env.ASSETS.get(storageKey, { range });
    if (!object) return translatorError(env, "Audio not found", 404, "NOT_FOUND");
    return new Response(object.body, { status: 206, headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const object = await env.ASSETS.get(storageKey);
  if (!object) return translatorError(env, "Audio not found", 404, "NOT_FOUND");
  return new Response(object.body, { status: 200, headers });
}

const REVENUECAT_PRODUCTS: Record<string, { points: number; reason: string }> = {
  "com.hn.AIPetStudio.points.100": { points: 100, reason: "purchase_points" },
  "com.hn.AIPetStudio.points.350": { points: 350, reason: "purchase_points" },
  "com.hn.AIPetStudio.points.900": { points: 900, reason: "purchase_points" },
  "com.hn.AIPetStudio.points.2200": { points: 2200, reason: "purchase_points" },
  "com.hn.AIPetStudio.subscription.weekly": { points: 300, reason: "subscription_points" },
  "com.hn.AIPetStudio.subscription.monthly": { points: 1200, reason: "subscription_points" },
  "com.hn.AIPetStudio.subscription.yearly": { points: 10000, reason: "subscription_points" }
};

type RevenueCatWebhookSignature = {
  timestamp: number;
  timestampText: string;
  signatures: Uint8Array[];
};

/** RevenueCat sends `t=<unix timestamp>,v1=<hex HMAC>` in this header. */
export function parseRevenueCatSignature(header: string | null): RevenueCatWebhookSignature | null {
  if (!header) return null;
  const fields = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    fields.set(name, [...(fields.get(name) || []), value]);
  }
  const timestampText = fields.get("t")?.[0] || "";
  if (!/^\d+$/.test(timestampText)) return null;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) return null;

  const signatures = (fields.get("v1") || []).flatMap(value => {
    if (!/^[0-9a-f]{64}$/i.test(value)) return [];
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return [bytes];
  });
  return signatures.length ? { timestamp, timestampText, signatures } : null;
}

export async function verifyRevenueCatSignature(
  env: Pick<Env, "REVENUECAT_WEBHOOK_SIGNING_SECRET">,
  rawBody: string,
  header: string | null,
  nowMs = Date.now()
): Promise<boolean> {
  const secret = env.REVENUECAT_WEBHOOK_SIGNING_SECRET?.trim();
  const parsed = parseRevenueCatSignature(header);
  if (!secret || !parsed || Math.abs(nowMs / 1000 - parsed.timestamp) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedPayload = new TextEncoder().encode(`${parsed.timestampText}.${rawBody}`);
  for (const signature of parsed.signatures) {
    if (await crypto.subtle.verify("HMAC", key, signature as unknown as BufferSource, signedPayload)) return true;
  }
  return false;
}

function secureStringEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

function verifyRevenueCatAuthorization(env: Env, request: Request): boolean {
  const expected = env.REVENUECAT_WEBHOOK_AUTH?.trim();
  if (!expected) return true;
  return secureStringEquals(expected, request.headers.get("Authorization") || "");
}

async function handleRevenueCatWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.REVENUECAT_WEBHOOK_SIGNING_SECRET?.trim()) return error("Webhook is not configured", 503, "CONFIGURATION_ERROR");
  if (!verifyRevenueCatAuthorization(env, request)) return error("Invalid RevenueCat webhook authorization", 401, "INVALID_AUTHORIZATION");
  const rawBody = await request.text();
  if (!(await verifyRevenueCatSignature(env, rawBody, request.headers.get("X-RevenueCat-Webhook-Signature")))) {
    return error("Invalid RevenueCat webhook signature", 401, "INVALID_SIGNATURE");
  }

  let payload: { event?: Record<string, any> };
  try { payload = JSON.parse(rawBody) as { event?: Record<string, any> }; }
  catch { return error("Invalid webhook body", 422, "INVALID_BODY"); }
  const event = payload.event || {};
  if (String(event.type || "") !== "VIRTUAL_CURRENCY_TRANSACTION") return json({ ok: true, ignored: true });
  if (String(event.source || "").toLowerCase() !== "in_app_purchase") return json({ ok: true, ignored: true });
  const environment = String(event.purchase_environment || event.environment || "").toUpperCase();
  if (environment && !["SANDBOX", "PRODUCTION"].includes(environment)) return json({ ok: true, ignored: true });

  const productID = String(event.product_id || "");
  const product = REVENUECAT_PRODUCTS[productID];
  const eventID = String(event.id || "").trim();
  const virtualTransactionID = String(event.virtual_currency_transaction_id || "").trim();
  const storeTransactionID = String(event.transaction_id || event.store_transaction_id || "").trim();
  const eventKey = virtualTransactionID || eventID;
  if (!product || !eventKey) {
    console.warn("RevenueCat webhook ignored: unknown product or event identifier");
    return json({ ok: true, ignored: true });
  }

  const adjustments = Array.isArray(event.adjustments) ? event.adjustments as Array<Record<string, any>> : [];
  const matchingAdjustments = adjustments.filter(adjustment => String(adjustment.currency?.code || "") === String(env.REVENUECAT_VIRTUAL_CURRENCY_CODE));
  const amount = matchingAdjustments.reduce((total, adjustment) => total + Number(adjustment.amount), 0);
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) !== product.points) {
    console.warn("RevenueCat webhook ignored: invalid PTS adjustment");
    return json({ ok: true, ignored: true });
  }

  const aliases = [event.app_user_id, event.original_app_user_id, ...(Array.isArray(event.aliases) ? event.aliases : [])]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  if (!aliases.length) return json({ ok: true, ignored: true });
  const placeholders = aliases.map(() => "?").join(",");
  const user = await env.DB.prepare(`SELECT id, customer_id, device_id FROM users WHERE deleted_at IS NULL AND customer_id IN (${placeholders})`)
    .bind(...aliases)
    .first<User>();
  if (!user) {
    console.warn("RevenueCat webhook ignored: customer was not found");
    return json({ ok: true, ignored: true });
  }

  const reference = `revenuecat:${eventKey}`;
  const reason = amount > 0 ? product.reason : "purchase_refund";
  await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .bind(id(), user.id, user.customer_id, amount, reason, reference, now())
    .run();
  const recorded = await env.DB.prepare("INSERT OR IGNORE INTO revenuecat_webhook_events(id, event_key, event_id, virtual_currency_transaction_id, store_transaction_id, customer_id, amount, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id(), eventKey, eventID || null, virtualTransactionID || null, storeTransactionID || null, user.customer_id, amount, now())
    .run();
  return json({ ok: true, duplicate: Number(recorded.meta?.changes || 0) === 0 });
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (path === "/healthz") return json({ ok: true, app: env.APP_NAME, timestamp: now() }, { headers: corsHeaders(env) });
  if (path === "/v1/webhooks/revenuecat" && request.method === "POST") return handleRevenueCatWebhook(request, env);
  const translatorAudioMatch = path.match(/^\/v1\/pet-translator\/audio\/([^/]+)$/);
  if (translatorAudioMatch && ["GET", "HEAD"].includes(request.method)) {
    return handleTranslationAudio(request, env, translatorAudioMatch[1]);
  }
  if (!env.JWT_SECRET || env.JWT_SECRET.trim().length < 32) return error("Worker JWT_SECRET is not configured", 503, "CONFIGURATION_ERROR");
  if (!(await verifyAppCheck(env, request))) return error("A valid Firebase App Check token is required", 401, "APP_CHECK_REQUIRED");

  if (path === "/v1/session/bootstrap" && request.method === "POST") {
    const body = await readBody(request);
    const deviceID = String(body.device_id || body.app_account_token || "").trim();
    if (!deviceID) return error("device_id is required", 422);
    const user = await ensureUser(env, deviceID);
    const token = await issueToken(env, user);
    return json({ access_token: token, refresh_token: token, customer_id: user.customer_id, expires_in: Number(env.ACCESS_TOKEN_TTL_SECONDS || 3600) }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/session/challenge" && request.method === "POST") {
    return json({ challenge_id: id(), challenge: crypto.randomUUID().replaceAll("-", "") }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/session/refresh" && request.method === "POST") {
    const body = await readBody(request);
    const token = String(body.refresh_token || "");
    const claims = await verifyToken(env, token);
    if (!claims) return error("Refresh token is invalid", 401, "UNAUTHORIZED");
    const user = await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE id = ? AND deleted_at IS NULL").bind(claims.sub).first<User>();
    if (!user) return error("User not found", 401, "UNAUTHORIZED");
    const refreshed = await issueToken(env, user);
    return json({ access_token: refreshed, refresh_token: refreshed, customer_id: user.customer_id, expires_in: Number(env.ACCESS_TOKEN_TTL_SECONDS || 3600) }, { headers: corsHeaders(env) });
  }

  const user = await userForRequest(request, env);
  if (!user) return error("Authentication required", 401, "UNAUTHORIZED");

  if (path === "/v1/pet-translator/pet-to-human" && request.method === "POST") {
    return handleTranslationRequest(request, env, user, "PET_TO_HUMAN", ctx);
  }
  if (path === "/v1/pet-translator/human-to-pet" && request.method === "POST") {
    return handleTranslationRequest(request, env, user, "HUMAN_TO_PET", ctx);
  }
  const translatorTaskMatch = path.match(/^\/v1\/pet-translator\/tasks\/([^/]+)$/);
  if (translatorTaskMatch && request.method === "GET") {
    const task = await loadTranslationTask(env, user.id, translatorTaskMatch[1]);
    if (!task) return translatorError(env, "Translation task not found", 404, "NOT_FOUND");
    return respondWithTranslationTask(request, env, task);
  }

  if (path === "/v1/me" && request.method === "GET") {
    return json({ id: user.id, customer_id: user.customer_id }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/me" && request.method === "DELETE") {
    const translationOutputs = await env.DB.prepare("SELECT output_key FROM pet_translation_tasks WHERE user_id = ? AND output_key IS NOT NULL")
      .bind(user.id).all<{ output_key: string }>();
    let outputsDeleted = true;
    for (const row of translationOutputs.results || []) {
      try { await env.ASSETS.delete(row.output_key); }
      catch (cause) { outputsDeleted = false; console.error("Translation output cleanup failed", cause); }
    }
    const deletedAt = now();
    await env.DB.prepare("UPDATE pet_translation_tasks SET state = 'expired', phase = 'expired', result_json = NULL, output_key = CASE WHEN ? = 1 THEN NULL ELSE output_key END, audio_source = 'none', sound_id = NULL, sound_library_version = NULL, sound_emotion = NULL, sound_intensity = NULL, sound_duration_seconds = NULL, expires_at = ?, updated_at = ? WHERE user_id = ?")
      .bind(outputsDeleted ? 1 : 0, deletedAt, deletedAt, user.id).run();
    await env.DB.prepare("UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(deletedAt, deletedAt, user.id).run();
    return json({ ok: true }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/wallet" && request.method === "GET") {
    await retryPendingRefunds(env, user);
    let points: PointsRead;
    try { points = await readPoints(env, user); }
    catch (cause) {
      if (cause instanceof RevenueCatRequestError) return error("Points service is temporarily unavailable", 503, "POINTS_PROVIDER_ERROR");
      throw cause;
    }
    const entitlement = await getEntitlement(env, user);
    const transactions = await env.DB.prepare(`
      SELECT id, amount, reason, reference, created_at
      FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).bind(user.id).all<Record<string, unknown>>();
    return json({
      balance: points.balance,
      entitlement,
      welcome_bonus_granted: points.welcomeBonusGranted,
      welcome_bonus_points: points.welcomeBonusGranted ? 20 : 0,
      transactions: transactions.results || []
    }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/wallet/transactions" && request.method === "GET") {
    const transactions = await env.DB.prepare(`
      SELECT id, amount, reason, reference, created_at
      FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
    `).bind(user.id).all<Record<string, unknown>>();
    return json({ items: transactions.results || [] }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/wallet/reconcile" && request.method === "POST") {
    await retryPendingRefunds(env, user);
    let points: PointsRead;
    try { points = await readPoints(env, user); }
    catch (cause) {
      if (cause instanceof RevenueCatRequestError) return error("Points service is temporarily unavailable", 503, "POINTS_PROVIDER_ERROR");
      throw cause;
    }
    return json({
      balance: points.balance,
      entitlement: await getEntitlement(env, user),
      welcome_bonus_granted: points.welcomeBonusGranted,
      welcome_bonus_points: points.welcomeBonusGranted ? 20 : 0,
      transactions: []
    }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/wallet/purchase-sync" && request.method === "POST") {
    const body = await readBody(request);
    const productID = String(body.product_id || "");
    const transactionID = String(body.transaction_identifier || "");
    const product = REVENUECAT_PRODUCTS[productID];
    if (!product || !transactionID) return error("Invalid purchase", 422, "INVALID_PURCHASE");
    const event = await env.DB.prepare("SELECT amount FROM revenuecat_webhook_events WHERE customer_id = ? AND (event_id = ? OR virtual_currency_transaction_id = ? OR store_transaction_id = ?) AND amount > 0").bind(user.customer_id, transactionID, transactionID, transactionID).first<{ amount: number }>();
    return json({ confirmed: Boolean(event && Number(event.amount) === product.points), balance: await getPoints(env, user) }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/uploads/images" && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return error("file is required", 422);
    if (file.size > 15 * 1024 * 1024) return error("Image is too large", 413, "FILE_TOO_LARGE");
    if (!["image/jpeg", "image/png", "image/heic", "image/heif"].includes(file.type)) return error("Unsupported image type", 415, "UNSUPPORTED_MEDIA");
    const extension = file.type.split("/")[1] || "jpg";
    const key = `users/${user.id}/uploads/${id()}.${extension}`;
    await env.ASSETS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    return json({ asset_id: key, url: mediaURL(request, key) }, { status: 201, headers: corsHeaders(env) });
  }
  if (path === "/v1/uploads/images" && request.method === "DELETE") {
    const body = await readBody(request);
    const assetID = String(body.asset_id || "").trim();
    if (!assetID.startsWith(`users/${user.id}/uploads/`)) return error("Upload does not belong to this account", 403, "FORBIDDEN");
    const object = await env.ASSETS.head(assetID);
    if (!object) return json({ ok: true, deleted: false }, { headers: corsHeaders(env) });
    const active = await env.DB.prepare("SELECT id FROM tasks WHERE state NOT IN ('succeeded', 'failed') AND input_json LIKE ? LIMIT 1")
      .bind(`%${assetID}%`)
      .first<{ id: string }>();
    if (active) return error("Upload is still referenced by an active task", 409, "UPLOAD_IN_USE");
    await env.ASSETS.delete(assetID);
    return json({ ok: true, deleted: true }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/tasks" && request.method === "GET") {
    const rawLimit = url.searchParams.get("limit");
    let limit = 30;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) return error("limit must be a positive integer", 422, "INVALID_LIMIT");
      limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1) return error("limit must be a positive integer", 422, "INVALID_LIMIT");
      limit = Math.min(limit, 50);
    }

    let cursor: { createdAt: string; id: string } | null = null;
    const rawCursor = url.searchParams.get("cursor");
    if (rawCursor) {
      try {
        const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(rawCursor))) as Record<string, unknown>;
        if (typeof decoded.created_at !== "string" || !decoded.created_at || typeof decoded.id !== "string" || !decoded.id) {
          return error("cursor is invalid", 422, "INVALID_CURSOR");
        }
        cursor = { createdAt: decoded.created_at, id: decoded.id };
      } catch {
        return error("cursor is invalid", 422, "INVALID_CURSOR");
      }
    }

    const taskQuery = cursor
      ? `SELECT * FROM tasks WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
      : `SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`;
    const taskRows = cursor
      ? await env.DB.prepare(taskQuery).bind(user.id, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1).all<Record<string, any>>()
      : await env.DB.prepare(taskQuery).bind(user.id, limit + 1).all<Record<string, any>>();
    const rows = taskRows.results || [];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(task => taskResponse(request, task));
    const last = rows[limit - 1];
    const nextCursor = hasMore && last
      ? base64url(JSON.stringify({ created_at: last.created_at, id: last.id }))
      : null;
    const summary = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total_count,
        COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0) AS image_count,
        COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0) AS video_count,
        COUNT(DISTINCT CASE WHEN template_id IS NOT NULL AND template_id != '' THEN template_id END) AS template_count
      FROM tasks WHERE user_id = ?
    `).bind(user.id).first<Record<string, unknown>>();

    return json({
      items,
      next_cursor: nextCursor,
      summary: {
        total_count: Number(summary?.total_count || 0),
        image_count: Number(summary?.image_count || 0),
        video_count: Number(summary?.video_count || 0),
        template_count: Number(summary?.template_count || 0)
      }
    }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/tasks" && request.method === "POST") {
    const body = await readBody(request);
    const allowedKeys = new Set(["template_id", "material_snapshot", "input_asset_ids", "client_request_id"]);
    const unsupportedKey = Object.keys(body).find(key => !allowedKeys.has(key));
    if (unsupportedKey) return error(`Unsupported task field: ${unsupportedKey}`, 422, "UNSUPPORTED_FIELD");
    const templateID = typeof body.template_id === "string" ? body.template_id.trim() : "";
    if (templateID.length > 200) return error("template_id is too long", 422, "INVALID_TEMPLATE");
    const snapshot = parseMaterialSnapshot(body.material_snapshot, templateID || null);
    if (!snapshot) return error("material_snapshot is invalid; a single-image snapshot with a valid prompt is required", 422, "INVALID_MATERIAL_SNAPSHOT");
    const assetIDs = Array.isArray(body.input_asset_ids) && body.input_asset_ids.every(asset => typeof asset === "string")
      ? body.input_asset_ids as string[] : [];
    if (assetIDs.length !== snapshot.image_count) return error("This template requires one input image", 422, "INPUT_COUNT_MISMATCH");
    if (new Set(assetIDs).size !== assetIDs.length) return error("Input assets must be unique", 422, "INPUT_COUNT_MISMATCH");
    if (assetIDs.some(assetID => !assetID.startsWith(`users/${user.id}/uploads/`))) return error("Input asset does not belong to user", 403, "FORBIDDEN");
    const assetObjects = await Promise.all(assetIDs.map(assetID => env.ASSETS.head(assetID)));
    if (assetObjects.some(object => !object)) return error("Input asset not found", 404, "NOT_FOUND");
    const clientRequestID = String(body.client_request_id || "").trim().slice(0, 120);
    if (!clientRequestID) return error("client_request_id is required", 422);
    if (clientRequestID) {
      const existing = await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND client_request_id = ?").bind(user.id, clientRequestID).first<Record<string, any>>();
      if (existing) return json(taskResponse(request, existing), { headers: corsHeaders(env) });
    }
    const operation = await env.DB.prepare("INSERT OR IGNORE INTO task_operations(user_id, client_request_id, task_id, status, updated_at) VALUES(?, ?, ?, 'pending', ?)").bind(user.id, clientRequestID, id(), now()).run();
    const operationRow = await env.DB.prepare("SELECT task_id, status FROM task_operations WHERE user_id = ? AND client_request_id = ?").bind(user.id, clientRequestID).first<{ task_id: string; status: string }>();
    if (!operationRow) throw new Error("TASK_OPERATION_RESERVATION_FAILED");
    if (Number(operation.meta?.changes || 0) === 0 && operationRow.status === "completed") {
      const existing = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(operationRow.task_id, user.id).first<Record<string, any>>();
      if (existing) return json(taskResponse(request, existing), { headers: corsHeaders(env) });
    }
    const taskID = operationRow.task_id;
    const debitKey = `task:${taskID}:debit`;
    const generationCost = GENERATION_COSTS[snapshot.kind];
    try { await debitPoints(env, user, generationCost, debitKey); }
    catch (cause) {
      if (cause instanceof Error && cause.message === "INSUFFICIENT_POINTS") return error("Not enough PTS", 402, "INSUFFICIENT_POINTS");
      if (cause instanceof RevenueCatRequestError) {
        if (cause.status === 422 && /balance|enough|insufficient/i.test(cause.providerMessage || "")) {
          return error("Not enough PTS", 402, "INSUFFICIENT_POINTS");
        }
        return error("Points service is temporarily unavailable", 503, "POINTS_PROVIDER_ERROR");
      }
      throw cause;
    }
    const templateTitle = snapshot.title || templateID || "自定义任务";
    await env.DB.prepare(`
      INSERT INTO tasks(id, user_id, template_id, template_title, kind, state, points, debit_key, input_json, material_snapshot_json, progress, retry_count, client_request_id, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).bind(taskID, user.id, templateID, templateTitle, snapshot.kind, "queued", generationCost, debitKey, JSON.stringify(assetIDs), JSON.stringify(snapshot), clientRequestID, now(), now()).run();
    if (!env.VIDU_API_KEY) {
      await refundPoints(env, user, generationCost, `task:${taskID}:refund`);
      await env.DB.prepare("UPDATE tasks SET state = 'failed', error_code = 'VIDU_NOT_CONFIGURED', error_message = ?, updated_at = ? WHERE id = ?")
        .bind("Vidu provider is not configured", now(), taskID).run();
    } else {
      // 创建时只做一次同步转发；后续进度由 App 轮询详情接口推进。
      await submitVidu(env, taskID, snapshot, assetIDs, user);
    }
    const createdTask = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(taskID, user.id).first<Record<string, any>>();
    await env.DB.prepare("UPDATE task_operations SET status = 'completed', updated_at = ? WHERE user_id = ? AND client_request_id = ?").bind(now(), user.id, clientRequestID).run();
    return json(taskResponse(request, createdTask || {
      id: taskID, state: "queued", kind: snapshot.kind, points: generationCost, progress: 0,
      artwork_id: null, input_json: JSON.stringify(assetIDs)
    }), { status: 201, headers: corsHeaders(env) });
  }
  const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskID = taskMatch[1];
    let task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(taskID, user.id).first<Record<string, any>>();
    if (!task) return error("Task not found", 404, "NOT_FOUND");
    if (request.method === "GET") {
      task = await refreshViduTask(env, task, user);
      return json(taskResponse(request, task), { headers: corsHeaders(env) });
    }
  }
  const artworkMatch = path.match(/^\/v1\/artworks\/([^/]+)$/);
  if (artworkMatch) {
    const artworkID = artworkMatch[1];
    const artwork = await env.DB.prepare("SELECT * FROM artworks WHERE id = ? AND user_id = ? AND deleted_at IS NULL").bind(artworkID, user.id).first<Record<string, any>>();
    if (!artwork) return error("Artwork not found", 404, "NOT_FOUND");
    if (request.method === "GET") return json({
      id: artwork.id,
      task_id: artwork.task_id,
      template_id: artwork.template_id,
      template_title: artwork.template_title,
      kind: artwork.kind,
      media_url: artwork.result_url,
      watermark: Boolean(artwork.watermark),
      created_at: artwork.created_at
    }, { headers: corsHeaders(env) });
  }
  if (path.startsWith("/v1/media/") && request.method === "GET") {
    const key = decodeURIComponent(path.slice("/v1/media/".length));
    if (!key.startsWith(`users/${user.id}/`)) return error("Media does not belong to user", 403, "FORBIDDEN");
    const object = await env.ASSETS.get(key);
    if (!object) return error("Media not found", 404, "NOT_FOUND");
    return new Response(object.body, { headers: { ...corsHeaders(env), "content-type": object.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, max-age=300" } });
  }
  return error("Route not found", 404, "NOT_FOUND");
}

function corsHeaders(env: Env): Record<string, string> {
  return { "access-control-allow-origin": env.CORS_ORIGINS || "*", "access-control-allow-headers": "Authorization, Content-Type, X-Request-ID, X-App-Attest, X-Firebase-AppCheck, Range", "access-control-allow-methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS", "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges" };
}
function mediaURL(request: Request, key: string): string {
  return `${new URL(request.url).origin}/v1/media/${encodeURIComponent(key)}`;
}
function inputAssetKey(task: Record<string, any>): string | null {
  if (typeof task.input_json !== "string") return null;
  try {
    const inputs = JSON.parse(task.input_json) as unknown;
    if (!Array.isArray(inputs)) return null;
    const candidate = inputs.find(value => typeof value === "string") as string | undefined;
    if (!candidate || (task.user_id && !candidate.startsWith(`users/${task.user_id}/`))) return null;
    return candidate;
  } catch {
    return null;
  }
}
function taskResponse(request: Request, task: Record<string, any>): Record<string, unknown> {
  const inputKey = inputAssetKey(task);
  const thumbnailKey = task.state === "succeeded" && task.kind === "image" && task.result_url
    ? task.result_url
    : inputKey;
  return {
    id: task.id,
    state: task.state,
    kind: task.kind,
    template_id: task.template_id || null,
    template_title: task.template_title || null,
    points: task.points,
    progress: Math.round(Number(task.progress || 0)),
    retry_count: Number(task.retry_count || 0),
    artwork_id: task.artwork_id,
    error_code: task.error_code,
    error_message: task.error_message,
    created_at: task.created_at,
    updated_at: task.updated_at,
    media_url: task.result_url || null,
    thumbnail_url: task.state === "succeeded" && task.kind === "image" && task.result_url
      ? task.result_url
      : (thumbnailKey ? mediaURL(request, thumbnailKey) : null)
  };
}

async function submitVidu(env: Env, taskID: string, snapshot: MaterialSnapshot, inputs: unknown[], user: User): Promise<void> {
  try {
    const images: string[] = [];
    for (const input of inputs) {
      const key = String(input);
      const object = await env.ASSETS.get(key);
      if (!object) throw new Error("Input asset disappeared");
      const contentType = object.httpMetadata?.contentType || "image/jpeg";
      images.push(`data:${contentType};base64,${base64(await object.arrayBuffer())}`);
    }
    const isImage = snapshot.kind === "image";
    const endpoint = `${env.VIDU_BASE_URL || "https://api.vidu.com"}/ent/v2/${isImage ? "reference2image" : "img2video"}`;
    const payload = isImage
      ? { model: env.VIDU_IMAGE_MODEL || "viduq2", prompt: snapshot.prompt, images, aspect_ratio: "auto", resolution: "1080p" }
      : { model: env.VIDU_VIDEO_MODEL || "viduq3-pro-fast", prompt: snapshot.prompt, images, duration: 4 };
    const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Token ${env.VIDU_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Vidu request failed (${response.status})`);
    const body = await response.json() as { task_id?: string; id?: string };
    const providerTaskID = body.task_id || body.id;
    if (!providerTaskID) throw new Error("Vidu response did not include a task id");
    await env.DB.prepare("UPDATE tasks SET provider_task_id = ?, state = 'processing', progress = 10, updated_at = ? WHERE id = ? AND user_id = ? AND state = 'queued'").bind(providerTaskID, now(), taskID, user.id).run();
  } catch (cause) {
    console.error("Vidu submit failed", cause);
    const retry = await env.DB.prepare("UPDATE tasks SET state = 'queued', retry_count = retry_count + 1, provider_task_id = NULL, progress = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND state NOT IN ('succeeded', 'failed') AND retry_count < 1")
      .bind(now(), taskID).run();
    if (Number(retry.meta?.changes || 0) > 0) {
      await submitVidu(env, taskID, snapshot, inputs, user);
      return;
    }
    const failed = await env.DB.prepare("UPDATE tasks SET state = 'failed', progress = 0, error_code = 'VIDU_REQUEST_FAILED', error_message = ?, updated_at = ? WHERE id = ? AND user_id = ? AND state NOT IN ('succeeded', 'failed')")
      .bind(String(cause instanceof Error ? cause.message : "Vidu request failed").slice(0, 500), now(), taskID, user.id)
      .run();
    if (Number(failed.meta?.changes || 0) > 0) await refundPoints(env, user, GENERATION_COSTS[snapshot.kind], `task:${taskID}:refund`);
  }
}

async function refreshViduTask(env: Env, task: Record<string, any>, user: User): Promise<Record<string, any>> {
  if (!task.provider_task_id || ["succeeded", "failed"].includes(String(task.state)) || !env.VIDU_API_KEY) return task;
  try {
    const response = await fetch(`${env.VIDU_BASE_URL || "https://api.vidu.com"}/ent/v2/tasks/${encodeURIComponent(String(task.provider_task_id))}/creations`, {
      headers: { Authorization: `Token ${env.VIDU_API_KEY}`, Accept: "application/json" }
    });
    if (!response.ok) return task;
    const body = await response.json() as { state?: string; progress?: number; err_code?: string; images?: string[]; creations?: Array<{ id?: string; url?: string; cover_url?: string }> };
    const state = String(body.state || "processing");
    if (["created", "queueing", "processing"].includes(state)) {
      const normalizedState = state === "processing" ? "processing" : "queued";
      const progress = Math.round(Math.max(1, Math.min(99, Number(body.progress || (normalizedState === "processing" ? 35 : 10)))));
      if (normalizedState !== task.state || progress !== Number(task.progress || 0)) await env.DB.prepare("UPDATE tasks SET state = ?, progress = ?, updated_at = ? WHERE id = ? AND state NOT IN ('succeeded', 'failed')").bind(normalizedState, progress, now(), task.id).run();
      return { ...task, state: normalizedState, progress };
    }
    if (state === "failed") {
      const failed = await env.DB.prepare("UPDATE tasks SET state = 'failed', progress = 0, error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND user_id = ? AND state NOT IN ('succeeded', 'failed')")
        .bind(body.err_code || "VIDU_GENERATION_FAILED", "Vidu could not generate the requested asset", now(), task.id, user.id)
        .run();
      if (Number(failed.meta?.changes || 0) > 0) await refundPoints(env, user, Number(task.points), `task:${task.id}:refund`);
      return { ...task, state: "failed", progress: 0, error_code: body.err_code || "VIDU_GENERATION_FAILED" };
    }
    if (state !== "success") return task;
    // Vidu's Get Creation API returns generated assets in `creations[].url`
    // for both image and video tasks. Keep `images[]` as a compatibility
    // fallback for older responses from the image endpoint.
    const outputURL = body.creations?.find(item => typeof item.url === "string" && item.url.length > 0)?.url
      || body.images?.find(item => typeof item === "string" && item.length > 0);
    if (!outputURL) {
      console.error("Vidu task succeeded without a result URL", {
        taskID: task.id,
        providerTaskID: task.provider_task_id,
        kind: task.kind
      });
      return task;
    }
    const artworkID = task.artwork_id || id();
    await env.DB.prepare("UPDATE tasks SET state = 'succeeded', progress = 100, artwork_id = ?, result_url = ?, updated_at = ? WHERE id = ? AND state NOT IN ('succeeded', 'failed')")
      .bind(artworkID, outputURL, now(), task.id).run();
    const artworkTitle = String(task.template_title || task.template_id || "自定义任务");
    await env.DB.prepare("INSERT OR IGNORE INTO artworks(id, user_id, task_id, template_id, template_title, kind, result_url, watermark, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?)")
      .bind(artworkID, user.id, task.id, task.template_id, artworkTitle, task.kind, outputURL, now()).run();
    return { ...task, state: "succeeded", progress: 100, artwork_id: artworkID, result_url: outputURL };
  } catch (cause) {
    console.error("Vidu refresh failed", cause);
    return task;
  }
}

async function cleanupOrphanUploads(env: Env): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const listing = await env.ASSETS.list({ prefix: "users/", limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of listing.objects) {
      if (!object.key.includes("/uploads/") || object.uploaded.getTime() >= cutoff) continue;
      const active = await env.DB.prepare("SELECT id FROM tasks WHERE state NOT IN ('succeeded', 'failed') AND input_json LIKE ? LIMIT 1")
        .bind(`%${object.key}%`)
        .first<{ id: string }>();
      if (!active) await env.ASSETS.delete(object.key);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

async function cleanupPetTranslationResults(env: Env): Promise<void> {
  const cutoff = now();
  const rows = await env.DB.prepare("SELECT id, output_key, audio_source FROM pet_translation_tasks WHERE expires_at <= ? AND (state != 'expired' OR output_key IS NOT NULL) LIMIT 500")
    .bind(cutoff).all<{ id: string; output_key?: string | null; audio_source?: string | null }>();
  for (const row of rows.results || []) {
    let deleted = true;
    if (row.output_key && row.audio_source !== "shared_library") {
      try { await env.ASSETS.delete(row.output_key); }
      catch (cause) { deleted = false; console.error("Pet translation result cleanup failed", { taskID: row.id, cause }); }
    }
    await env.DB.prepare("UPDATE pet_translation_tasks SET state = 'expired', phase = 'expired', result_json = NULL, output_key = CASE WHEN ? = 1 THEN NULL ELSE output_key END, audio_source = 'none', sound_id = NULL, sound_library_version = NULL, sound_emotion = NULL, sound_intensity = NULL, sound_duration_seconds = NULL, updated_at = ? WHERE id = ?")
      .bind(deleted ? 1 : 0, now(), row.id).run();
  }
}

async function cleanupOrphanTranslationOutputs(env: Env): Promise<void> {
  const cutoff = Date.now() - translationResultTTLDays(env) * 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const listing = await env.ASSETS.list({ prefix: "users/", limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of listing.objects) {
      if (!object.key.includes("/pet-translator/output/") || object.uploaded.getTime() >= cutoff) continue;
      const referenced = await env.DB.prepare("SELECT id FROM pet_translation_tasks WHERE output_key = ? LIMIT 1").bind(object.key).first<{ id: string }>();
      if (!referenced) await env.ASSETS.delete(object.key);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

async function retryAllPendingRefunds(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT DISTINCT user_id FROM pending_refunds WHERE status = 'pending' LIMIT 100")
    .all<{ user_id: string }>();
  for (const row of rows.results || []) {
    // Refunds are billing recovery work and must continue after a soft account
    // deletion; the customer record is still needed to reconcile RevenueCat.
    const user = await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE id = ?")
      .bind(row.user_id).first<User>();
    if (!user) continue;
    await retryPendingRefunds(env, user);
    const completed = await env.DB.prepare("SELECT reference FROM pending_refunds WHERE user_id = ? AND status = 'completed' AND reference LIKE 'pet-translator:%:refund'")
      .bind(user.id).all<{ reference: string }>();
    for (const row of completed.results || []) {
      const taskID = row.reference.replace(/^pet-translator:(.*):refund$/, "$1");
      await env.DB.prepare("UPDATE pet_translation_tasks SET state = CASE WHEN state = 'processing' THEN 'succeeded' ELSE state END, refund_status = 'completed', phase = CASE WHEN state IN ('processing', 'succeeded') THEN 'completed' ELSE phase END, updated_at = ? WHERE id = ? AND refund_status = 'pending'")
        .bind(now(), taskID).run();
    }
  }
}

async function retryPendingTranslationTaskRefunds(env: Env): Promise<void> {
  // The task row is a second durable recovery queue for the narrow case where
  // a database interruption happened while creating pending_refunds.
  const rows = await env.DB.prepare("SELECT * FROM pet_translation_tasks WHERE refund_status = 'pending' LIMIT 100").all<PetTranslationTask>();
  for (const task of rows.results || []) {
    const user = await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE id = ?").bind(task.user_id).first<User>();
    if (!user) continue;
    const refund = await refundTranslationPoints(env, user, task.id, Number(task.credit_cost));
    if (refund === "completed") {
      await updateTranslationTask(env, task.id, {
        state: task.state === "processing" ? "succeeded" : task.state,
        phase: task.state === "processing" || task.state === "succeeded" ? "completed" : task.phase,
        refund_status: "completed",
        updated_at: now()
      });
    }
  }
}

async function reconcileUnknownTranslationDebits(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM pet_translation_tasks WHERE debit_status = 'unknown' AND refund_status = 'manual_review' LIMIT 100")
    .all<PetTranslationTask>();
  for (const task of rows.results || []) {
    const user = await env.DB.prepare("SELECT id, customer_id, device_id, welcome_bonus_granted_at FROM users WHERE id = ?")
      .bind(task.user_id).first<User>();
    if (!user) continue;
    try {
      // Reusing the original idempotency key either returns the already
      // accepted debit or safely completes the one unresolved adjustment.
      const providerBalance = await revenueCatAdjust(env, user.customer_id, -Number(task.credit_cost), task.debit_key);
      if (providerBalance === null) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, 'generation_debit', ?, ?)")
        .bind(id(), user.id, user.customer_id, -Number(task.credit_cost), task.debit_key, now()).run();
      const refund = await refundTranslationPoints(env, user, task.id, Number(task.credit_cost));
      await updateTranslationTask(env, task.id, { debit_status: "confirmed", refund_status: refund === "completed" ? "completed" : "pending", phase: refund === "completed" ? "failed" : "refund_pending", updated_at: now() });
    } catch (cause) {
      console.error("Unknown pet translation debit reconciliation failed", { taskID: task.id, cause });
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try { return await handle(request, env, ctx); }
    catch (cause) { console.error("Unhandled request failure", cause); return error("Internal server error", 500, "INTERNAL_ERROR"); }
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try { await cleanupOrphanUploads(env); }
    catch (cause) { console.error("Upload cleanup failed", cause); }
    try { await cleanupPetTranslationResults(env); }
    catch (cause) { console.error("Pet translation result cleanup failed", cause); }
    try { await cleanupOrphanTranslationOutputs(env); }
    catch (cause) { console.error("Pet translation orphan cleanup failed", cause); }
    try { await retryAllPendingRefunds(env); }
    catch (cause) { console.error("Pending refund reconciliation failed", cause); }
    try { await retryPendingTranslationTaskRefunds(env); }
    catch (cause) { console.error("Pet translation task refund recovery failed", cause); }
    try { await reconcileUnknownTranslationDebits(env); }
    catch (cause) { console.error("Unknown debit reconciliation failed", cause); }
  }
};
