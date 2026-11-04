export function assertSafeArchivePath(root: string, entryPath: string): string;

export function enforceArchiveEntryLimit(
  state: { entries: number; expandedBytes: number },
  entry: { size: number; type?: string },
  limits?: {
    maxEntries?: number;
    maxExpandedBytes?: number;
  },
): void;
