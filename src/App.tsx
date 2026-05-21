import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import {
  ConflictState,
  FileMeta,
  FileStatus,
  applyExternalChange,
  markDirty,
  markSaved,
  startFileSession,
  updateConflictLocalContent,
} from "./lib/fileState";

type FileEntry = {
  name: string;
  relative_path: string;
  is_dir: boolean;
  depth: number;
};

type WorkspaceInfo = {
  root: string;
  files: FileEntry[];
};

type FilePayload = {
  relative_path: string;
  content: string;
  hash: string;
  mtime_ms: number;
};

type WorkspaceEvent = {
  relative_path: string;
  kind: "created" | "modified" | "deleted" | "changed";
  hash: string | null;
};

type TerminalOutput = {
  session_id: string;
  data: string;
};

type FormattingAction = "heading" | "bold" | "italic" | "code" | "link";

const markdownExtensions = [
  markdown(),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { height: "100%" },
    ".cm-scroller": { fontFamily: "var(--font-mono)" },
  }),
];

const RECENT_LOCAL_EDIT_CONFLICT_WINDOW_MS = 15_000;
const LAST_WORKSPACE_KEY = "maka:lastWorkspace";
const LAYOUT_MODE_KEY = "maka:layoutMode";
const TERMINAL_EXPANDED_KEY = "maka:terminalExpanded";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
    });
    return mermaid;
  });
  return mermaidPromise;
}

type LayoutMode = "split" | "editor" | "preview";

function isLayoutMode(value: string | null): value is LayoutMode {
  return value === "split" || value === "editor" || value === "preview";
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeFile, setActiveFile] = useState<FileMeta | null>(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<FileStatus>("idle");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [lastSavedHash, setLastSavedHash] = useState<string | null>(null);
  const [lastWrittenHash, setLastWrittenHash] = useState<string | null>(null);
  const [message, setMessage] = useState("로컬 폴더를 열어 Markdown 작업을 시작하세요.");
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [restoringWorkspace, setRestoringWorkspace] = useState(false);
  const [layoutMode, setLayoutModeState] = useState<LayoutMode>(() => {
    if (typeof window === "undefined") return "split";
    const saved = window.localStorage.getItem(LAYOUT_MODE_KEY);
    return isLayoutMode(saved) ? saved : "split";
  });
  const [terminalExpanded, setTerminalExpandedState] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(TERMINAL_EXPANDED_KEY) !== "false";
  });
  const saveTimer = useRef<number | null>(null);
  const lastLocalEditAt = useRef<number | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewScrollTopBeforeEdit = useRef<number | null>(null);
  const suppressPreviewSyncUntil = useRef(0);
  const restoreAttempted = useRef(false);

  const markdownFiles = useMemo(
    () => workspace?.files.filter((entry) => !entry.is_dir) ?? [],
    [workspace],
  );

  const editorExtensions = useMemo(
    () => [
      ...markdownExtensions,
      EditorView.domEventHandlers({
        scroll: (_event, view) => {
          const preview = previewRef.current;
          if (!preview || layoutMode === "editor") return false;
          if (Date.now() < suppressPreviewSyncUntil.current) return false;
          const source = view.scrollDOM;
          const sourceMax = source.scrollHeight - source.clientHeight;
          const previewMax = preview.scrollHeight - preview.clientHeight;
          if (sourceMax <= 0 || previewMax <= 0) return false;
          preview.scrollTop = (source.scrollTop / sourceMax) * previewMax;
          return false;
        },
      }),
    ],
    [layoutMode],
  );

  const refreshFiles = useCallback(async () => {
    const files = await invoke<FileEntry[]>("list_files");
    setWorkspace((current) => (current ? { ...current, files } : current));
  }, []);

  const setLayoutMode = useCallback((next: LayoutMode) => {
    setLayoutModeState(next);
    window.localStorage.setItem(LAYOUT_MODE_KEY, next);
  }, []);

  const setTerminalExpanded = useCallback((expanded: boolean) => {
    setTerminalExpandedState(expanded);
    window.localStorage.setItem(TERMINAL_EXPANDED_KEY, String(expanded));
  }, []);

  const resetOpenFileState = useCallback(() => {
    setActiveFile(null);
    setContent("");
    setConflict(null);
    setStatus("idle");
    setLastSavedHash(null);
    setLastWrittenHash(null);
    lastLocalEditAt.current = null;
  }, []);

  const loadWorkspacePath = useCallback(
    async (rootPath: string, options: { persist: boolean; restored?: boolean }) => {
      const next = await invoke<WorkspaceInfo>("set_workspace", {
        rootPath,
      });
      await invoke("start_watch");
      setWorkspace(next);
      resetOpenFileState();
      if (options.persist) {
        window.localStorage.setItem(LAST_WORKSPACE_KEY, next.root);
      }
      setMessage(options.restored ? `마지막 workspace 복원됨: ${next.root}` : `${next.root} 열림`);
      return next;
    },
    [resetOpenFileState],
  );

  const readActiveFile = useCallback(
    async (relativePath: string) => {
      const payload = await invoke<FilePayload>("read_file", {
        relativePath,
      });
      setActiveFile(startFileSession(payload.relative_path, payload.hash, payload.mtime_ms));
      setContent(payload.content);
      setLastSavedHash(payload.hash);
      setLastWrittenHash(null);
      lastLocalEditAt.current = null;
      setConflict(null);
      setStatus("clean");
      setMessage(`${payload.relative_path} 열림`);
    },
    [],
  );

  const openWorkspace = useCallback(async () => {
    setOpeningWorkspace(true);
    setMessage("폴더를 선택하는 중입니다.");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Maka workspace 열기",
      });
      if (selected === null || Array.isArray(selected)) {
        setMessage("폴더 열기를 취소했습니다.");
        return;
      }
      await loadWorkspacePath(selected, { persist: true });
    } catch (error) {
      setMessage(`폴더 열기 실패: ${String(error)}`);
    } finally {
      setOpeningWorkspace(false);
    }
  }, [loadWorkspacePath]);

  const createMarkdownFile = useCallback(async () => {
    if (!workspace) return;
    const name = window.prompt("새 Markdown 파일 이름", "Untitled.md");
    if (!name) return;
    try {
      const payload = await invoke<FilePayload>("create_file", { relativePath: name });
      await refreshFiles();
      await readActiveFile(payload.relative_path);
      setMessage(`새 파일 생성됨: ${payload.relative_path}`);
    } catch (error) {
      setMessage(`새 파일 생성 실패: ${String(error)}`);
    }
  }, [readActiveFile, refreshFiles, workspace]);

  const renameActiveFile = useCallback(async () => {
    if (!activeFile || conflict || status === "dirty" || status === "saving" || status === "deleted") return;
    const nextName = window.prompt("새 파일 경로 또는 이름", activeFile.relativePath);
    if (!nextName || nextName === activeFile.relativePath) return;
    try {
      const payload = await invoke<FilePayload>("rename_file", {
        oldRelativePath: activeFile.relativePath,
        newRelativePath: nextName,
      });
      await refreshFiles();
      await readActiveFile(payload.relative_path);
      setMessage(`파일 이름 변경됨: ${payload.relative_path}`);
    } catch (error) {
      setMessage(`파일 이름 변경 실패: ${String(error)}`);
    }
  }, [activeFile, conflict, readActiveFile, refreshFiles, status]);

  const deleteActiveFile = useCallback(async () => {
    if (!activeFile || conflict || status === "dirty" || status === "saving" || status === "deleted") return;
    const ok = window.confirm(`${activeFile.relativePath} 파일을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`);
    if (!ok) return;
    try {
      await invoke("delete_file", { relativePath: activeFile.relativePath });
      await refreshFiles();
      resetOpenFileState();
      setMessage(`파일 삭제됨: ${activeFile.relativePath}`);
    } catch (error) {
      setMessage(`파일 삭제 실패: ${String(error)}`);
    }
  }, [activeFile, refreshFiles, resetOpenFileState, status]);

  const saveFile = useCallback(
    async (nextContent = content, force = false) => {
      if (!activeFile || conflict || status === "deleted" || (!force && status !== "dirty")) return;
      setStatus("saving");
      const payload = await invoke<FilePayload>("write_file", {
        relativePath: activeFile.relativePath,
        content: nextContent,
      });
      setActiveFile((current) =>
        current ? markSaved(current, payload.hash, payload.mtime_ms) : current,
      );
      setLastSavedHash(payload.hash);
      setLastWrittenHash(payload.hash);
      setStatus("clean");
      setMessage(`저장됨: ${payload.relative_path}`);
      await refreshFiles();
    },
    [activeFile, conflict, content, refreshFiles, status],
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      previewScrollTopBeforeEdit.current = previewRef.current?.scrollTop ?? null;
      suppressPreviewSyncUntil.current = Date.now() + 250;
      setContent(value);
      lastLocalEditAt.current = Date.now();
      setConflict((current) => (current ? updateConflictLocalContent(current, value) : current));
      setActiveFile((current) => (current ? markDirty(current) : current));
      setStatus(activeFile ? (conflict ? "conflicted" : "dirty") : "idle");
    },
    [activeFile, conflict],
  );

  useLayoutEffect(() => {
    const previousScrollTop = previewScrollTopBeforeEdit.current;
    const preview = previewRef.current;
    if (previousScrollTop === null || !preview) return;
    preview.scrollTop = previousScrollTop;
    previewScrollTopBeforeEdit.current = null;
  }, [content]);

  const applyFormatting = useCallback((action: FormattingAction) => {
    const view = editorViewRef.current;
    if (!view || !activeFile || conflict || status === "deleted") return;
    const selection = view.state.selection.main;
    const selected = view.state.doc.sliceString(selection.from, selection.to);
    const wrap = (before: string, after = before, fallback = "text") => {
      const value = selected || fallback;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: `${before}${value}${after}` },
        selection: {
          anchor: selection.from + before.length,
          head: selection.from + before.length + value.length,
        },
        scrollIntoView: true,
      });
      view.focus();
    };

    if (action === "heading") {
      const line = view.state.doc.lineAt(selection.from);
      view.dispatch({ changes: { from: line.from, insert: "# " }, scrollIntoView: true });
      view.focus();
      return;
    }
    if (action === "bold") wrap("**", "**", "bold text");
    if (action === "italic") wrap("_", "_", "italic text");
    if (action === "code") wrap("`", "`", "code");
    if (action === "link") wrap("[", "](https://)", "link text");
  }, [activeFile, conflict, status]);

  const resolveKeepLocal = useCallback(() => {
    setConflict(null);
    setStatus("dirty");
    setMessage("로컬 편집을 유지합니다. 다음 autosave가 디스크를 갱신합니다.");
  }, []);

  const resolveLoadExternal = useCallback(() => {
    if (!activeFile || !conflict) return;
    setContent(conflict.externalContent);
    setActiveFile(markSaved(activeFile, conflict.externalHash, conflict.externalMtimeMs));
    setLastSavedHash(conflict.externalHash);
    setLastWrittenHash(null);
    lastLocalEditAt.current = null;
    setConflict(null);
    setStatus("clean");
    setMessage("외부 변경을 불러왔습니다.");
  }, [activeFile, conflict]);

  const copyExternal = useCallback(async () => {
    if (!conflict) return;
    await navigator.clipboard.writeText(conflict.externalContent);
    setMessage("외부 버전을 클립보드에 복사했습니다.");
  }, [conflict]);

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    const savedWorkspace = window.localStorage.getItem(LAST_WORKSPACE_KEY);
    if (!savedWorkspace) return;

    let cancelled = false;
    setRestoringWorkspace(true);
    setMessage("마지막 workspace를 복원하는 중입니다.");
    loadWorkspacePath(savedWorkspace, { persist: false, restored: true })
      .catch((error) => {
        if (!cancelled) {
          window.localStorage.removeItem(LAST_WORKSPACE_KEY);
          setMessage(`마지막 workspace 복원 실패: ${String(error)}`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRestoringWorkspace(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadWorkspacePath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "o") {
        event.preventDefault();
        void openWorkspace();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        void saveFile(content, true);
        return;
      }
      if (key === "n") {
        event.preventDefault();
        void createMarkdownFile();
        return;
      }
      if (key === "b") {
        event.preventDefault();
        applyFormatting("bold");
        return;
      }
      if (key === "i") {
        event.preventDefault();
        applyFormatting("italic");
        return;
      }
      if (key === "k") {
        event.preventDefault();
        applyFormatting("link");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyFormatting, content, createMarkdownFile, openWorkspace, saveFile]);

  useEffect(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    if (!activeFile || conflict || status !== "dirty") return;
    saveTimer.current = window.setTimeout(() => {
      void saveFile(content);
    }, 900);
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, [activeFile, conflict, content, saveFile, status]);

  useEffect(() => {
    const unlistenPromise = listen<WorkspaceEvent>("workspace-event", async (event) => {
      const payload = event.payload;
      await refreshFiles();
      if (!activeFile || payload.relative_path !== activeFile.relativePath) return;
      if (payload.kind === "deleted") {
        setStatus("deleted");
        setMessage("현재 파일이 외부에서 삭제되었습니다. 로컬 버퍼는 유지됩니다.");
        return;
      }
      if (payload.hash && payload.hash === lastWrittenHash) {
        setLastSavedHash(payload.hash);
        return;
      }
      const external = await invoke<FilePayload>("read_file", {
        relativePath: activeFile.relativePath,
      });
      if (external.hash === lastSavedHash && status !== "dirty") return;
      const hasRecentLocalEdit =
        lastLocalEditAt.current !== null &&
        Date.now() - lastLocalEditAt.current < RECENT_LOCAL_EDIT_CONFLICT_WINDOW_MS;
      const fileForExternalChange =
        hasRecentLocalEdit && external.content !== content
          ? { ...activeFile, dirty: true }
          : activeFile;

      const result = applyExternalChange(fileForExternalChange, {
        externalHash: external.hash,
        externalContent: external.content,
        externalMtimeMs: external.mtime_ms,
        currentContent: content,
      });

      if (result.kind === "reload") {
        setContent(external.content);
        setActiveFile(result.file);
        setLastSavedHash(external.hash);
        setStatus("clean");
        setMessage("외부 변경을 자동 반영했습니다.");
      } else if (result.kind === "conflict") {
        setConflict(result.conflict);
        setStatus("conflicted");
        setMessage("외부 변경과 로컬 편집이 충돌했습니다.");
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [activeFile, content, lastSavedHash, lastWrittenHash, refreshFiles, status]);

  return (
    <main className={`app-shell ${terminalExpanded ? "" : "terminal-collapsed"}`}>
      <header className="topbar">
        <div>
          <h1>Maka</h1>
          <span>{workspace?.root ?? "No workspace"}</span>
        </div>
        <div className="topbar-actions">
          <LayoutToggle mode={layoutMode} onChange={setLayoutMode} />
          <button
            disabled={openingWorkspace || restoringWorkspace}
            onClick={openWorkspace}
            title="⌘O"
          >
            {openingWorkspace ? "여는 중..." : restoringWorkspace ? "복원 중..." : "폴더 열기"}
          </button>
          <button
            title="⌘S"
            disabled={!activeFile || Boolean(conflict) || status === "saving" || status === "deleted"}
            onClick={() => void saveFile(content, true)}
          >
            저장
          </button>
        </div>
      </header>

      {conflict ? (
        <section className="conflict-banner">
          <strong>외부 변경 충돌</strong>
          <span>현재 로컬 편집과 디스크의 새 버전이 다릅니다.</span>
          <button onClick={resolveKeepLocal}>로컬 유지</button>
          <button onClick={resolveLoadExternal}>외부 버전 불러오기</button>
          <button onClick={() => void copyExternal()}>외부 버전 복사</button>
        </section>
      ) : null}

      <section className={`workspace workspace-${layoutMode}`}>
        <aside className="file-pane">
          <div className="pane-title">
            <span>Files</span>
            <span className="file-actions">
              <button disabled={!workspace} onClick={() => void createMarkdownFile()} title="⌘N">
                +
              </button>
              <button
                disabled={
                  !activeFile ||
                  Boolean(conflict) ||
                  status === "dirty" ||
                  status === "saving" ||
                  status === "deleted"
                }
                onClick={() => void renameActiveFile()}
              >
                이름
              </button>
              <button
                disabled={
                  !activeFile ||
                  Boolean(conflict) ||
                  status === "dirty" ||
                  status === "saving" ||
                  status === "deleted"
                }
                onClick={() => void deleteActiveFile()}
              >
                삭제
              </button>
            </span>
          </div>
          {workspace ? (
            <FileList
              entries={workspace.files}
              activePath={activeFile?.relativePath}
              onOpen={(path) => void readActiveFile(path)}
            />
          ) : (
            <p className="empty">폴더를 열면 Markdown 파일이 표시됩니다.</p>
          )}
        </aside>

        <section className="editor-pane">
          <div className="pane-title">
            <span>{activeFile?.relativePath ?? "Editor"}</span>
            <span className="editor-actions">
              <button
                disabled={!activeFile || Boolean(conflict) || status === "deleted"}
                onClick={() => applyFormatting("heading")}
              >
                H1
              </button>
              <button
                disabled={!activeFile || Boolean(conflict) || status === "deleted"}
                onClick={() => applyFormatting("bold")}
              >
                B
              </button>
              <button
                disabled={!activeFile || Boolean(conflict) || status === "deleted"}
                onClick={() => applyFormatting("italic")}
              >
                I
              </button>
              <button
                disabled={!activeFile || Boolean(conflict) || status === "deleted"}
                onClick={() => applyFormatting("code")}
              >
                Code
              </button>
              <button
                disabled={!activeFile || Boolean(conflict) || status === "deleted"}
                onClick={() => applyFormatting("link")}
              >
                Link
              </button>
              <span className={`status-pill status-${status}`}>{status}</span>
            </span>
          </div>
          {activeFile ? (
            <CodeMirror
              className="markdown-editor"
              value={content}
              height="100%"
              extensions={editorExtensions}
              onChange={handleEditorChange}
              onCreateEditor={(view) => {
                editorViewRef.current = view;
              }}
              basicSetup={{
                foldGutter: false,
                highlightActiveLine: true,
                highlightSelectionMatches: true,
              }}
            />
          ) : (
            <div className="empty editor-empty">
              {markdownFiles.length ? "파일을 선택하세요." : "열린 Markdown 파일이 없습니다."}
            </div>
          )}
        </section>

        <section className="preview-pane">
          <div className="pane-title">Preview</div>
          <div className="preview-scroll" ref={previewRef}>
            <MarkdownPreview markdown={content} />
          </div>
        </section>
      </section>

      <TerminalPanel
        workspaceRoot={workspace?.root ?? null}
        expanded={terminalExpanded}
        onExpandedChange={setTerminalExpanded}
      />

      <footer className="statusbar">
        <span>{message}</span>
        <span className="statusbar-hints">⌘O 열기 · ⌘N 새 파일 · ⌘S 저장 · ⌘B/I/K 서식</span>
      </footer>
    </main>
  );
}

function LayoutToggle({
  mode,
  onChange,
}: {
  mode: LayoutMode;
  onChange: (mode: LayoutMode) => void;
}) {
  return (
    <div className="layout-toggle" aria-label="편집기 레이아웃">
      <button
        className={mode === "split" ? "active-layout" : ""}
        onClick={() => onChange("split")}
      >
        분할
      </button>
      <button
        className={mode === "editor" ? "active-layout" : ""}
        onClick={() => onChange("editor")}
      >
        편집
      </button>
      <button
        className={mode === "preview" ? "active-layout" : ""}
        onClick={() => onChange("preview")}
      >
        미리보기
      </button>
    </div>
  );
}

function FileList({
  entries,
  activePath,
  onOpen,
}: {
  entries: FileEntry[];
  activePath?: string;
  onOpen: (path: string) => void;
}) {
  if (!entries.length) return <p className="empty">Markdown 파일이 없습니다.</p>;
  return (
    <ul className="file-list">
      {entries.map((entry) => (
        <li key={entry.relative_path} style={{ paddingLeft: 10 + entry.depth * 14 }}>
          {entry.is_dir ? (
            <span className="directory">{entry.name}</span>
          ) : (
            <button
              className={entry.relative_path === activePath ? "active-file" : ""}
              onClick={() => onOpen(entry.relative_path)}
            >
              {entry.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <article className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          code({ children, className, ...props }) {
            const language = /language-(\w+)/.exec(className ?? "")?.[1];
            const value = String(children ?? "").replace(/\n$/, "");
            if (language === "mermaid") {
              return <MermaidDiagram chart={value} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}

function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState("");
  const id = useMemo(() => `mermaid-${Math.random().toString(36).slice(2)}`, [chart]);

  useEffect(() => {
    let cancelled = false;
    setSvg("<em>Mermaid diagram loading...</em>");
    loadMermaid()
      .then((mermaid) => mermaid.render(id, chart))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((error) => {
        if (!cancelled) setSvg(`<pre>${escapeHtml(String(error))}</pre>`);
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function TerminalPanel({
  workspaceRoot,
  expanded,
  onExpandedChange,
}: {
  workspaceRoot: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<
    "workspace required" | "idle" | "starting" | "running" | "failed"
  >("workspace required");

  useEffect(() => {
    setEnabled(false);
    setTerminalStatus(workspaceRoot ? "idle" : "workspace required");
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot || !enabled || !containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      theme: {
        background: "#15171c",
        foreground: "#e5e7eb",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    safeFit(fit, containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    setTerminalStatus("starting");

    let disposed = false;
    let activeSession: string | null = null;

    invoke<string>("start_terminal", {
      cols: terminal.cols,
      rows: terminal.rows,
    }).then((id) => {
      if (disposed) {
        void invoke("stop_terminal", { sessionId: id });
        return;
      }
      activeSession = id;
      setTerminalStatus("running");
      terminal.focus();
    }).catch((error) => {
      if (disposed) return;
      setTerminalStatus("failed");
      terminal.writeln(`터미널 시작 실패: ${String(error)}`);
    });

    const dataDisposable = terminal.onData((data) => {
      if (activeSession) {
        void invoke("terminal_write", { sessionId: activeSession, data });
      }
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (activeSession) {
        void invoke("terminal_resize", { sessionId: activeSession, cols, rows });
      }
    });
    const unlistenPromise = listen<TerminalOutput>("terminal-output", (event) => {
      if (event.payload.session_id === activeSession) {
        terminal.write(event.payload.data);
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        safeFit(fit, containerRef.current);
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      void unlistenPromise.then((unlisten) => unlisten());
      if (activeSession) {
        void invoke("stop_terminal", { sessionId: activeSession });
      }
      setTerminalStatus(workspaceRoot ? "idle" : "workspace required");
      terminal.dispose();
    };
  }, [enabled, workspaceRoot]);

  useEffect(() => {
    if (!expanded || !containerRef.current) return;
    safeFit(fitRef.current, containerRef.current);
  }, [expanded]);

  return (
    <section className={`terminal-pane ${expanded ? "" : "terminal-pane-collapsed"}`}>
      <div className="pane-title">
        <span>Terminal</span>
        <span className="terminal-actions">
          <span>{terminalStatus}</span>
          <button onClick={() => onExpandedChange(!expanded)}>
            {expanded ? "접기" : "펼치기"}
          </button>
          {enabled ? (
            <button onClick={() => setEnabled(false)}>터미널 중지</button>
          ) : (
            <button disabled={!workspaceRoot} onClick={() => setEnabled(true)}>
              터미널 시작
            </button>
          )}
        </span>
      </div>
      <div className="terminal-container" ref={containerRef}>
        {!enabled ? (
          <div className="terminal-placeholder">
            폴더를 연 뒤 터미널 시작을 누르면 workspace 기준 셸이 열립니다.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function safeFit(fit: FitAddon | null, container: HTMLElement) {
  if (!fit || container.clientWidth <= 0 || container.clientHeight <= 0) return;
  fit.fit();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
