import { readStoredString, writeStoredString } from "./stored-preference";

const STORAGE_KEY = "rakazo:skill-marketplaces";
const MAX_SAVED = 30;

export type SavedMarketplace = { url: string; name: string };

/** Git repositories this browser saved as skill marketplaces, newest first. */
export function readSavedMarketplaces(): SavedMarketplace[] {
  try {
    const parsed: unknown = JSON.parse(readStoredString(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SavedMarketplace =>
        typeof entry?.url === "string" && typeof entry?.name === "string",
    );
  } catch {
    return [];
  }
}

export function writeSavedMarketplaces(list: SavedMarketplace[]): SavedMarketplace[] {
  const unique = list.filter(
    (entry, index) => list.findIndex((other) => other.url === entry.url) === index,
  );
  const kept = unique.slice(0, MAX_SAVED);
  writeStoredString(STORAGE_KEY, kept.length ? JSON.stringify(kept) : null);
  return kept;
}
