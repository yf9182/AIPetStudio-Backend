import type { Species } from "./petTranslator";

export const PET_SOUND_LIBRARY_VERSION = "v1" as const;

export const PET_SOUND_EMOTIONS = [
  "happy",
  "excited",
  "affectionate",
  "calm",
  "curious",
  "play_invitation",
  "attention_seeking",
  "displeased",
  "afraid",
  "alert"
] as const;

export type PetSoundEmotion = typeof PET_SOUND_EMOTIONS[number];
export type PetSoundIntensity = "low" | "medium" | "high";
export type PetSoundReviewStatus = "pending" | "approved" | "rejected";

export const PET_SOUND_EMOTION_LABELS: Record<PetSoundEmotion, string> = {
  happy: "开心",
  excited: "兴奋",
  affectionate: "亲昵",
  calm: "平静",
  curious: "好奇",
  play_invitation: "邀请玩耍",
  attention_seeking: "寻求关注",
  displeased: "不满",
  afraid: "害怕",
  alert: "警戒"
};

export const PET_SOUND_INTENSITIES: readonly PetSoundIntensity[] = ["low", "medium", "high"];

export type PetSoundRecord = {
  id: string;
  library_version: string;
  species: Species;
  emotion: PetSoundEmotion;
  intensity: PetSoundIntensity;
  vocalization: string;
  storage_key: string;
  duration_seconds: number;
  mime_type: "audio/mpeg";
  source_url: string;
  source_title: string;
  source_author: string;
  source_license: "CC0" | "Public Domain";
  source_license_url: string;
  downloaded_at: string;
  sha256: string;
  review_status: PetSoundReviewStatus;
  created_at?: string;
  updated_at?: string;
};

const EMOTION_ALIASES: Record<string, PetSoundEmotion> = {
  happy: "happy",
  joy: "happy",
  cheerful: "happy",
  开心: "happy",
  高兴: "happy",
  excited: "excited",
  excitement: "excited",
  兴奋: "excited",
  affectionate: "affectionate",
  affection: "affectionate",
  loving: "affectionate",
  亲昵: "affectionate",
  亲密: "affectionate",
  calm: "calm",
  peaceful: "calm",
  平静: "calm",
  安静: "calm",
  curious: "curious",
  curiosity: "curious",
  好奇: "curious",
  play_invitation: "play_invitation",
  play: "play_invitation",
  playful: "play_invitation",
  invite_play: "play_invitation",
  邀请玩耍: "play_invitation",
  玩耍: "play_invitation",
  attention_seeking: "attention_seeking",
  attention: "attention_seeking",
  seeking_attention: "attention_seeking",
  寻求关注: "attention_seeking",
  求关注: "attention_seeking",
  displeased: "displeased",
  annoyed: "displeased",
  unhappy: "displeased",
  不满: "displeased",
  生气: "displeased",
  afraid: "afraid",
  fearful: "afraid",
  scared: "afraid",
  害怕: "afraid",
  恐惧: "afraid",
  alert: "alert",
  warning: "alert",
  警戒: "alert",
  警觉: "alert"
};

export function normalizePetSoundEmotion(value: unknown): PetSoundEmotion | null {
  const key = String(value ?? "").trim().toLowerCase();
  return EMOTION_ALIASES[key] || null;
}

function intensityDistance(left: PetSoundIntensity, right: PetSoundIntensity): number {
  return Math.abs(PET_SOUND_INTENSITIES.indexOf(left) - PET_SOUND_INTENSITIES.indexOf(right));
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectPetSound(
  candidates: readonly PetSoundRecord[],
  species: Species,
  emotion: PetSoundEmotion,
  intensity: PetSoundIntensity,
  taskID: string
): PetSoundRecord | null {
  if ((species !== "cat" && species !== "dog") || !PET_SOUND_EMOTIONS.includes(emotion) || !PET_SOUND_INTENSITIES.includes(intensity)) return null;
  const sameEmotion = candidates
    .filter(candidate => candidate.review_status === "approved" && candidate.species === species && candidate.emotion === emotion)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!sameEmotion.length) return null;
  const nearestDistance = Math.min(...sameEmotion.map(candidate => intensityDistance(candidate.intensity, intensity)));
  const nearest = sameEmotion.filter(candidate => intensityDistance(candidate.intensity, intensity) === nearestDistance);
  return nearest[stableHash(taskID) % nearest.length] || null;
}

function isSafeStorageKey(value: unknown, libraryVersion: string): value is string {
  return typeof value === "string"
    && value.startsWith(`pet-translator/library/${libraryVersion}/`)
    && !value.includes("..")
    && !value.includes("\\")
    && !value.includes("?")
    && !value.includes("#");
}

export function validatePetSoundRecord(value: unknown, expectedVersion = PET_SOUND_LIBRARY_VERSION): PetSoundRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sound record must be an object");
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const libraryVersion = typeof record.library_version === "string" ? record.library_version.trim() : "";
  const species = record.species;
  const emotion = normalizePetSoundEmotion(record.emotion);
  const intensity = record.intensity;
  const vocalization = typeof record.vocalization === "string" ? record.vocalization.trim() : "";
  const storageKey = record.storage_key;
  const duration = Number(record.duration_seconds);
  const mime = record.mime_type;
  const sourceURL = typeof record.source_url === "string" ? record.source_url.trim() : "";
  const sourceTitle = typeof record.source_title === "string" ? record.source_title.trim() : "";
  const sourceAuthor = typeof record.source_author === "string" ? record.source_author.trim() : "";
  const license = record.source_license;
  const licenseURL = typeof record.source_license_url === "string" ? record.source_license_url.trim() : "";
  const downloadedAt = typeof record.downloaded_at === "string" ? record.downloaded_at.trim() : "";
  const sha256 = typeof record.sha256 === "string" ? record.sha256.trim().toLowerCase() : "";
  const reviewStatus = record.review_status;
  if (!id || id.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("sound id is invalid");
  if (libraryVersion !== expectedVersion) throw new Error("sound library version is invalid");
  if (species !== "cat" && species !== "dog") throw new Error("sound species is invalid");
  if (!emotion || !PET_SOUND_EMOTIONS.includes(emotion)) throw new Error("sound emotion is invalid");
  if (!PET_SOUND_INTENSITIES.includes(intensity as PetSoundIntensity)) throw new Error("sound intensity is invalid");
  if (!vocalization || vocalization.length > 120) throw new Error("sound vocalization is invalid");
  if (!isSafeStorageKey(storageKey, expectedVersion)) throw new Error("sound storage key is invalid");
  if (!Number.isFinite(duration) || duration < 2 || duration > 5) throw new Error("sound duration must be between 2 and 5 seconds");
  if (mime !== "audio/mpeg") throw new Error("sound MIME type must be audio/mpeg");
  if (!/^https:\/\//i.test(sourceURL)) throw new Error("sound source URL is invalid");
  if (!sourceTitle || sourceTitle.length > 300) throw new Error("sound source title is invalid");
  if (!sourceAuthor || sourceAuthor.length > 200) throw new Error("sound source author is invalid");
  if (license !== "CC0" && license !== "Public Domain") throw new Error("sound license is not allowed");
  if (!/^https:\/\//i.test(licenseURL)) throw new Error("sound license URL is invalid");
  if (!/^\d{4}-\d{2}-\d{2}/.test(downloadedAt)) throw new Error("sound download date is invalid");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sound SHA-256 is invalid");
  if (!["pending", "approved", "rejected"].includes(String(reviewStatus))) throw new Error("sound review status is invalid");
  return {
    id,
    library_version: libraryVersion,
    species,
    emotion,
    intensity: intensity as PetSoundIntensity,
    vocalization,
    storage_key: storageKey,
    duration_seconds: Math.round(duration * 1000) / 1000,
    mime_type: "audio/mpeg",
    source_url: sourceURL,
    source_title: sourceTitle,
    source_author: sourceAuthor,
    source_license: license as "CC0" | "Public Domain",
    source_license_url: licenseURL,
    downloaded_at: downloadedAt,
    sha256,
    review_status: reviewStatus as PetSoundReviewStatus
  };
}

export function validatePetSoundManifest(values: unknown, expectedVersion = PET_SOUND_LIBRARY_VERSION): PetSoundRecord[] {
  if (!Array.isArray(values)) throw new Error("sound manifest must be an array");
  const records = values.map(value => validatePetSoundRecord(value, expectedVersion));
  const ids = new Set<string>();
  const keys = new Set<string>();
  const sourceHashes = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`duplicate sound id: ${record.id}`);
    if (keys.has(record.storage_key)) throw new Error(`duplicate sound storage key: ${record.storage_key}`);
    if (sourceHashes.has(record.sha256)) throw new Error(`duplicate sound SHA-256: ${record.sha256}`);
    ids.add(record.id);
    keys.add(record.storage_key);
    sourceHashes.add(record.sha256);
  }
  return records;
}
