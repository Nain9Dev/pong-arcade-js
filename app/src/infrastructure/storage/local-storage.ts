import type { StoragePort } from '../../application/ports';

/**
 * `localStorage` adapter that never throws.
 *
 * Persistence here only carries preferences and high scores, so every failure
 * mode — storage disabled by policy, private browsing, quota exhausted, a value
 * corrupted by an older build — degrades to "no data" rather than taking the
 * game down with it.
 */

const resolveStore = (): Storage | null => {
  try {
    // The property access itself throws when site data is blocked.
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const createLocalStorage = (namespace: string): StoragePort => {
  const store = resolveStore();
  const prefix = `${namespace}:`;

  return {
    read<T>(key: string): T | null {
      if (store === null) return null;
      try {
        const raw = store.getItem(prefix + key);
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch {
        // Corrupt entries are left in place: a future build may still read them.
        return null;
      }
    },

    write<T>(key: string, value: T): void {
      if (store === null) return;
      try {
        const raw = JSON.stringify(value);
        // `undefined` serialises to nothing; storing the literal string would
        // come back as an unparseable value on the next read.
        if (raw === undefined) return;
        store.setItem(prefix + key, raw);
      } catch {
        // Quota or policy denial — dropping the write is the correct outcome.
      }
    },
  };
};
