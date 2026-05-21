import { describe, expect, it } from "vitest";
import {
  applyExternalChange,
  markDirty,
  markSaved,
  startFileSession,
  updateConflictLocalContent,
} from "./fileState";

describe("file state transitions", () => {
  it("starts clean from a disk snapshot", () => {
    const file = startFileSession("README.md", "hash-a", 100);
    expect(file.dirty).toBe(false);
    expect(file.lastKnownDiskHash).toBe("hash-a");
  });

  it("marks editor changes as dirty", () => {
    const file = markDirty(startFileSession("README.md", "hash-a", 100));
    expect(file.dirty).toBe(true);
  });

  it("marks a successful save as clean and records the disk snapshot", () => {
    const dirty = markDirty(startFileSession("README.md", "hash-a", 100));
    const saved = markSaved(dirty, "hash-b", 200);
    expect(saved.dirty).toBe(false);
    expect(saved.lastKnownDiskHash).toBe("hash-b");
    expect(saved.lastKnownMtimeMs).toBe(200);
  });

  it("ignores same-hash external writes while refreshing metadata", () => {
    const file = startFileSession("README.md", "hash-a", 100);
    const result = applyExternalChange(file, {
      externalHash: "hash-a",
      externalContent: "same",
      externalMtimeMs: 300,
      currentContent: "same",
    });
    expect(result.kind).toBe("ignore");
    if (result.kind === "ignore") {
      expect(result.file.lastKnownMtimeMs).toBe(300);
    }
  });

  it("reloads external changes when local buffer is clean", () => {
    const file = startFileSession("README.md", "hash-a", 100);
    const result = applyExternalChange(file, {
      externalHash: "hash-b",
      externalContent: "external",
      externalMtimeMs: 200,
      currentContent: "old",
    });
    expect(result.kind).toBe("reload");
  });

  it("creates a conflict when dirty local content differs from external content", () => {
    const file = markDirty(startFileSession("README.md", "hash-a", 100));
    const result = applyExternalChange(file, {
      externalHash: "hash-b",
      externalContent: "external",
      externalMtimeMs: 200,
      currentContent: "local",
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.conflict.localContent).toBe("local");
      expect(result.conflict.externalContent).toBe("external");
    }
  });

  it("clears dirty state when external content matches the current buffer", () => {
    const file = markDirty(startFileSession("README.md", "hash-a", 100));
    const result = applyExternalChange(file, {
      externalHash: "hash-b",
      externalContent: "same",
      externalMtimeMs: 200,
      currentContent: "same",
    });
    expect(result.kind).toBe("reload");
    if (result.kind === "reload") {
      expect(result.file.dirty).toBe(false);
    }
  });

  it("preserves local conflict content for keep-local resolution", () => {
    const file = markDirty(startFileSession("README.md", "hash-a", 100));
    const result = applyExternalChange(file, {
      externalHash: "hash-b",
      externalContent: "external draft",
      externalMtimeMs: 200,
      currentContent: "local draft",
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.conflict.localContent).toBe("local draft");
      expect(result.conflict.externalHash).toBe("hash-b");
    }
  });

  it("can mark an externally loaded conflict resolution as saved", () => {
    const file = markDirty(startFileSession("README.md", "hash-a", 100));
    const result = applyExternalChange(file, {
      externalHash: "hash-b",
      externalContent: "external",
      externalMtimeMs: 200,
      currentContent: "local",
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      const resolved = markSaved(file, result.conflict.externalHash, result.conflict.externalMtimeMs);
      expect(resolved.dirty).toBe(false);
      expect(resolved.lastKnownDiskHash).toBe("hash-b");
    }
  });

  it("keeps the conflict active while refreshing local conflicted edits", () => {
    const file = markDirty(startFileSession("README.md", "hash-a", 100));
    const result = applyExternalChange(file, {
      externalHash: "hash-b",
      externalContent: "external",
      externalMtimeMs: 200,
      currentContent: "local v1",
    });

    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      const updated = updateConflictLocalContent(result.conflict, "local v2");
      expect(updated).toMatchObject({
        localContent: "local v2",
        externalContent: "external",
        externalHash: "hash-b",
      });
    }
  });
});
