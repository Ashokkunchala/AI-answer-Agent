import { randomUUID } from 'node:crypto';

export function newId() {
  return randomUUID();
}

// Encode externally supplied IDs before using them as a single filename.
// UUIDs remain unchanged, while separators and platform-reserved characters
// cannot escape the storage directory.
export function storageFilename(id) {
  return `${encodeURIComponent(String(id))}.json`;
}
