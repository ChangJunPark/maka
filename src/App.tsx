import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import mermaid from "mermaid";
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

type LayoutMode = "split" | "editor" | "preview";

function isLayoutMode(value: string | null): value is LayoutMode {
  return value === "split" || value === "editor" || value === "preview";
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
});

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
  const saveTimer = useRef<number | null>(null);
  const lastLocalEditAt = useRef<number | null>(null);
  const restoreAttempted = useRef(false);

  const markdownFiles = useMemo(
    () => workspace?.files.filter((entry) => !entry.is_dir) ?? [],
    [workspace],
  );

  const refreshFiles = useCallback(async () => {
    const files = await invoke<FileEntry[]>("list_files");
    setWorkspace((current) => (current ? { ...current, files } : current));
  }, []);

  const setLayoutMode = useCallback((next: LayoutMode) => {
    setLayoutModeState(next);
    window.localStorage.setItem(LAYOUT_MODE_KEY, next);
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

  const saveFile = useCallback(
    async (nextContent = content, force = false) => {
      if (!activeFile || conflict || (!force && status !== "dirty")) return;
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
      setContent(value);
      lastLocalEditAt.current = Date.now();
      setConflict((current) => (current ? updateConflictLocalContent(current, value) : current));
      setActiveFile((current) => (current ? markDirty(current) : current));
      setStatus(activeFile ? (conflict ? "conflicted" : "dirty") : "idle");
    },
    [activeFile, conflict],
  );

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
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [content, openWorkspace, saveFile]);

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
    <main className="app-shell">
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
            disabled={!activeFile || Boolean(conflict) || status === "saving"}
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
          <div className="pane-title">Files</div>
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
            <span className={`status-pill status-${status}`}>{status}</span>
          </div>
          {activeFile ? (
            <CodeMirror
              value={content}
              height="100%"
              extensions={markdownExtensions}
              onChange={handleEditorChange}
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
          <MarkdownPreview markdown={content} />
        </section>
      </section>

      <TerminalPanel workspaceRoot={workspace?.root ?? null} />

      <footer className="statusbar">{message}</footer>
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
    mermaid
      .render(id, chart)
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

function TerminalPanel({ workspaceRoot }: { workspaceRoot: string | null }) {
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
    fit.fit();
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
      fit.fit();
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

  return (
    <section className="terminal-pane">
      <div className="pane-title">
        <span>Terminal</span>
        <span className="terminal-actions">
          <span>{terminalStatus}</span>
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
