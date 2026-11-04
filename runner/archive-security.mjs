import path from "node:path";

export function assertSafeArchivePath(root, entryPath) {
  const normalized = entryPath.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Project archive contains an unsafe path.");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Project archive path escapes the workspace.");
  }
  return resolved;
}

export function enforceArchiveEntryLimit(
  state,
  entry,
  {
    maxEntries = 20_000,
    maxExpandedBytes = 1024 * 1024 * 1024,
  } = {},
) {
  state.entries += 1;
  state.expandedBytes += entry.size;
  if (state.entries > maxEntries || state.expandedBytes > maxExpandedBytes) {
    throw new Error("Migration snapshot exceeds extraction limits.");
  }
  if (
    "type" in entry &&
    (entry.type === "SymbolicLink" || entry.type === "Link")
  ) {
    throw new Error("Migration snapshots may not contain links.");
  }
}
