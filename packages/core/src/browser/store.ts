// BT-6, BT-13: the object store for a run's files. The port is small on purpose; the Supabase
// Storage adapter is built with the deployment, behind a tenant policy on the tenants/<id>/ prefix.
export interface BrowserArtifactStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

export interface MemoryArtifactStore extends BrowserArtifactStore {
  keys(): string[];
}
export function createMemoryArtifactStore(): MemoryArtifactStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key, bytes, contentType) { objects.set(key, { bytes: new Uint8Array(bytes), contentType }); },
    async get(key) { const found = objects.get(key); return found ? { bytes: new Uint8Array(found.bytes), contentType: found.contentType } : null; },
    keys: () => [...objects.keys()],
  };
}
