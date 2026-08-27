export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  APP_NAME: string;
  REVENUECAT_PROJECT_ID: string;
  REVENUECAT_VIRTUAL_CURRENCY_CODE: string;
  REVENUECAT_API_BASE_URL: string;
  REVENUECAT_SECRET_KEY?: string;
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
}

type User = { id: string; customer_id: string; device_id: string; welcome_bonus_granted_at?: string | null };
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
async function revenueCatAdjust(env: Env, customerID: string, amount: number, reference: string): Promise<number | null> {
  if (!env.REVENUECAT_SECRET_KEY) return null;
  const endpoint = `${env.REVENUECAT_API_BASE_URL}/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID)}/customers/${encodeURIComponent(customerID)}/virtual_currencies/transactions`;
  const response = await fetch(endpoint, {
    method: "POST",
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
  return await grantPoints(env, user, amount, "generation_refund", reference);
}
async function syncSignupPointsToRevenueCat(env: Env, user: User): Promise<boolean> {
  if (!env.REVENUECAT_SECRET_KEY) return false;
  if (user.welcome_bonus_granted_at) return false;
  const amount = 20;
  const reference = `signup:${user.id}`;
  // The first bootstrap can happen before the RevenueCat SDK creates this
  // customer. Reusing the signup reference makes the later retry idempotent.
  const providerBalance = await revenueCatAdjust(env, user.customer_id, amount, reference);
  if (providerBalance === null) return false;
  const grantedAt = now();
  await env.DB.prepare("UPDATE users SET welcome_bonus_granted_at = ?, updated_at = ? WHERE id = ? AND welcome_bonus_granted_at IS NULL")
    .bind(grantedAt, grantedAt, user.id).run();
  await env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id, user_id, customer_id, amount, reason, reference, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .bind(id(), user.id, user.customer_id, amount, "signup", reference, grantedAt).run();
  return true;
}
type PointsRead = { balance: number; welcomeBonusGranted: boolean };
async function revenueCatBalance(env: Env, user: User): Promise<number | null> {
  const response = await fetch(`${env.REVENUECAT_API_BASE_URL}/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID)}/customers/${encodeURIComponent(user.customer_id)}/virtual_currencies`, {
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
  if (!env.REVENUECAT_SECRET_KEY) return null;
  try {
    const endpoint = `${env.REVENUECAT_API_BASE_URL}/v1/subscribers/${encodeURIComponent(user.customer_id)}`;
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) return null;
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

const REVENUECAT_PRODUCTS: Record<string, { points: number; reason: string }> = {
  "com.hn.AIPetStudio.points.100": { points: 100, reason: "purchase_points" },
  "com.hn.AIPetStudio.points.500": { points: 500, reason: "purchase_points" },
  "com.hn.AIPetStudio.points.1000": { points: 1000, reason: "purchase_points" },
  "com.hn.AIPetStudio.subscription.weekly": { points: 200, reason: "subscription_points" },
  "com.hn.AIPetStudio.subscription.monthly": { points: 800, reason: "subscription_points" },
  "com.hn.AIPetStudio.subscription.yearly": { points: 10000, reason: "subscription_points" }
};

function decodeWebhookSignature(value: string): Uint8Array | null {
  const normalized = value.trim().replace(/^sha256=/i, "");
  if (!normalized) return null;
  if (/^[0-9a-f]{64}$/i.test(normalized)) {
    const result = new Uint8Array(32);
    for (let index = 0; index < result.length; index += 1) {
      result[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return result;
  }
  try {
    return Uint8Array.from(atob(normalized.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((normalized.length + 3) % 4)), char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function verifyRevenueCatSignature(env: Env, rawBody: string, header: string | null): Promise<boolean> {
  if (!env.REVENUECAT_WEBHOOK_AUTH || !header) return false;
  const signature = decodeWebhookSignature(header);
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.REVENUECAT_WEBHOOK_AUTH),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const body = new TextEncoder().encode(rawBody);
  return await crypto.subtle.verify("HMAC", key, signature as unknown as BufferSource, body);
}

async function handleRevenueCatWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.REVENUECAT_WEBHOOK_AUTH) return error("Webhook is not configured", 503, "CONFIGURATION_ERROR");
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
  const recorded = await env.DB.prepare("INSERT OR IGNORE INTO revenuecat_webhook_events(id, event_key, event_id, virtual_currency_transaction_id, customer_id, amount, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .bind(id(), eventKey, eventID || null, virtualTransactionID || null, user.customer_id, amount, now())
    .run();
  return json({ ok: true, duplicate: Number(recorded.meta?.changes || 0) === 0 });
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (path === "/healthz") return json({ ok: true, app: env.APP_NAME, timestamp: now() }, { headers: corsHeaders(env) });
  if (path === "/v1/webhooks/revenuecat" && request.method === "POST") return handleRevenueCatWebhook(request, env);
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

  if (path === "/v1/me" && request.method === "GET") {
    return json({ id: user.id, customer_id: user.customer_id }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/me" && request.method === "DELETE") {
    await env.DB.prepare("UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), user.id).run();
    return json({ ok: true }, { headers: corsHeaders(env) });
  }
  if (path === "/v1/wallet" && request.method === "GET") {
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
    const taskID = id();
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
  return { "access-control-allow-origin": env.CORS_ORIGINS || "*", "access-control-allow-headers": "Authorization, Content-Type, X-App-Attest, X-Firebase-AppCheck", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS" };
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try { return await handle(request, env, ctx); }
    catch (cause) { console.error("Unhandled request failure", cause); return error("Internal server error", 500, "INTERNAL_ERROR"); }
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try { await cleanupOrphanUploads(env); }
    catch (cause) { console.error("Upload cleanup failed", cause); }
  }
};
