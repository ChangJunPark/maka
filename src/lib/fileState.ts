export type FileStatus =
  | "idle"
  | "clean"
  | "dirty"
  | "saving"
  | "conflicted"
  | "deleted";

export type FileMeta = {
  relativePath: string;
  lastKnownDiskHash: string;
  lastKnownMtimeMs: number;
  dirty: boolean;
};

export type ConflictState = {
  relativePath: string;
  localContent: string;
  externalContent: string;
  externalHash: string;
  externalMtimeMs: number;
};

export function startFileSession(
  relativePath: string,
  diskHash: string,
  mtimeMs: number,
): FileMeta {
  return {
    relativePath,
    lastKnownDiskHash: diskHash,
    lastKnownMtimeMs: mtimeMs,
    dirty: false,
  };
}

export function markDirty(file: FileMeta): FileMeta {
  return {
    ...file,
    dirty: true,
  };
}

export function markSaved(file: FileMeta, diskHash: string, mtimeMs: number): FileMeta {
  return {
    ...file,
    dirty: false,
    lastKnownDiskHash: diskHash,
    lastKnownMtimeMs: mtimeMs,
  };
}

export function updateConflictLocalContent(
  conflict: ConflictState,
  localContent: string,
): ConflictState {
  return {
    ...conflict,
    localContent,
  };
}

export function applyExternalChange(
  file: FileMeta,
  input: {
    externalHash: string;
    externalContent: string;
    externalMtimeMs: number;
    currentContent: string;
  },
):
  | { kind: "ignore"; file: FileMeta }
  | { kind: "reload"; file: FileMeta }
  | { kind: "conflict"; conflict: ConflictState } {
  if (input.externalHash === file.lastKnownDiskHash) {
    return {
      kind: "ignore",
      file: {
        ...file,
        lastKnownMtimeMs: input.externalMtimeMs,
      },
    };
  }

  if (!file.dirty) {
    return {
      kind: "reload",
      file: {
        ...file,
        dirty: false,
        lastKnownDiskHash: input.externalHash,
        lastKnownMtimeMs: input.externalMtimeMs,
      },
    };
  }

  if (input.externalContent === input.currentContent) {
    return {
      kind: "reload",
      file: {
        ...file,
        dirty: false,
        lastKnownDiskHash: input.externalHash,
        lastKnownMtimeMs: input.externalMtimeMs,
      },
    };
  }

  return {
    kind: "conflict",
    conflict: {
      relativePath: file.relativePath,
      localContent: input.currentContent,
      externalContent: input.externalContent,
      externalHash: input.externalHash,
      externalMtimeMs: input.externalMtimeMs,
    },
  };
}
