use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

#[derive(Default)]
struct AppState {
    workspace_root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    terminals: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn Write + Send>,
}

#[derive(Serialize)]
struct WorkspaceInfo {
    root: String,
    files: Vec<FileEntry>,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    relative_path: String,
    is_dir: bool,
    depth: usize,
}

#[derive(Serialize)]
struct FilePayload {
    relative_path: String,
    content: String,
    hash: String,
    mtime_ms: u128,
}

#[derive(Serialize, Clone)]
struct WorkspaceEvent {
    relative_path: String,
    kind: String,
    hash: Option<String>,
}

#[derive(Serialize, Clone)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[tauri::command]
fn set_workspace(root_path: String, state: State<AppState>) -> Result<WorkspaceInfo, String> {
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|err| format!("failed to canonicalize workspace: {err}"))?;
    if !root.is_dir() {
        return Err("workspace path is not a directory".to_string());
    }
    let files = list_markdown_entries(&root)?;
    *state.workspace_root.lock().map_err(lock_error)? = Some(root.clone());
    Ok(WorkspaceInfo {
        root: root.to_string_lossy().to_string(),
        files,
    })
}

#[tauri::command]
fn list_files(state: State<AppState>) -> Result<Vec<FileEntry>, String> {
    let root = workspace_root(&state)?;
    list_markdown_entries(&root)
}

#[tauri::command]
fn read_file(relative_path: String, state: State<AppState>) -> Result<FilePayload, String> {
    let root = workspace_root(&state)?;
    let path = safe_join(&root, &relative_path)?;
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read {relative_path}: {err}"))?;
    Ok(file_payload(relative_path, content, &path)?)
}

#[tauri::command]
fn write_file(
    relative_path: String,
    content: String,
    state: State<AppState>,
) -> Result<FilePayload, String> {
    let root = workspace_root(&state)?;
    let path = safe_join(&root, &relative_path)?;
    fs::write(&path, &content).map_err(|err| format!("failed to write {relative_path}: {err}"))?;
    Ok(file_payload(relative_path, content, &path)?)
}

#[tauri::command]
fn start_watch(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let root = workspace_root(&state)?;
    let watch_root = root.clone();
    let emit_root = root.clone();
    let app_for_events = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| {
            if let Ok(event) = result {
                emit_workspace_event(&app_for_events, &emit_root, event);
            }
        },
        Config::default().with_poll_interval(Duration::from_secs(1)),
    )
    .map_err(|err| format!("failed to create watcher: {err}"))?;
    watcher
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(|err| format!("failed to watch workspace: {err}"))?;
    *state.watcher.lock().map_err(lock_error)? = Some(watcher);
    Ok(())
}

#[tauri::command]
fn start_terminal(
    app: AppHandle,
    state: State<AppState>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let root = workspace_root(&state)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to open pty: {err}"))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut command = CommandBuilder::new(shell);
    command.cwd(root);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("failed to spawn shell: {err}"))?;
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|err| format!("failed to clone pty reader: {err}"))?;
    let writer = master
        .take_writer()
        .map_err(|err| format!("failed to create pty writer: {err}"))?;
    let session_id = Uuid::new_v4().to_string();
    let reader_session_id = session_id.clone();
    let app_for_reader = app.clone();

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_for_reader.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: reader_session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    state.terminals.lock().map_err(lock_error)?.insert(
        session_id.clone(),
        TerminalSession {
            master,
            child,
            writer,
        },
    );
    Ok(session_id)
}

#[tauri::command]
fn terminal_write(session_id: String, data: String, state: State<AppState>) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(lock_error)?;
    let session = terminals
        .get_mut(&session_id)
        .ok_or_else(|| "unknown terminal session".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("failed to write terminal input: {err}"))?;
    session
        .writer
        .flush()
        .map_err(|err| format!("failed to flush terminal input: {err}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<AppState>,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(lock_error)?;
    let session = terminals
        .get_mut(&session_id)
        .ok_or_else(|| "unknown terminal session".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to resize terminal: {err}"))?;
    Ok(())
}

#[tauri::command]
fn stop_terminal(session_id: String, state: State<AppState>) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(lock_error)?;
    if let Some(mut session) = terminals.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_workspace,
            list_files,
            read_file,
            write_file,
            start_watch,
            start_terminal,
            terminal_write,
            terminal_resize,
            stop_terminal
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            app.listen("tauri://close-requested", move |_| {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut terminals) = state.terminals.lock() {
                        for (_, mut session) in terminals.drain() {
                            let _ = session.child.kill();
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn workspace_root(state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .workspace_root
        .lock()
        .map_err(lock_error)?
        .clone()
        .ok_or_else(|| "workspace is not open".to_string())
}

fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("path traversal is not allowed".to_string());
    }

    let candidate = root.join(relative);
    let parent = candidate
        .parent()
        .ok_or_else(|| "file path has no parent".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|err| format!("failed to canonicalize parent path: {err}"))?;
    if !canonical_parent.starts_with(root) {
        return Err("path escapes workspace root".to_string());
    }
    Ok(candidate)
}

fn list_markdown_entries(root: &Path) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_descend)
    {
        let entry = entry.map_err(|err| format!("failed to walk workspace: {err}"))?;
        if entry.path() == root {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        let include = is_dir || is_markdown_file(entry.path());
        if !include {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|err| format!("failed to relativize path: {err}"))?;
        let depth = relative.components().count().saturating_sub(1);
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            relative_path: relative.to_string_lossy().to_string(),
            is_dir,
            depth,
        });
    }
    entries.sort_by(|a, b| {
        a.relative_path
            .to_lowercase()
            .cmp(&b.relative_path.to_lowercase())
    });
    Ok(entries)
}

fn should_descend(entry: &DirEntry) -> bool {
    let file_name = entry.file_name().to_string_lossy();
    !matches!(
        file_name.as_ref(),
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".turbo"
    )
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_lowercase().as_str(), "md" | "markdown" | "mdx"))
        .unwrap_or(false)
}

fn file_payload(
    relative_path: String,
    content: String,
    path: &Path,
) -> Result<FilePayload, String> {
    Ok(FilePayload {
        relative_path,
        hash: hash_content(&content),
        mtime_ms: modified_ms(path)?,
        content,
    })
}

fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn modified_ms(path: &Path) -> Result<u128, String> {
    let modified = path
        .metadata()
        .map_err(|err| format!("failed to read metadata: {err}"))?
        .modified()
        .unwrap_or_else(|_| SystemTime::now());
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis())
}

fn emit_workspace_event(app: &AppHandle, root: &Path, event: Event) {
    for path in event.paths {
        if !is_markdown_file(&path) {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative_path = relative.to_string_lossy().to_string();
        let hash = fs::read_to_string(&path)
            .ok()
            .map(|content| hash_content(&content));
        let kind = match event.kind {
            EventKind::Create(_) => "created",
            EventKind::Modify(_) => "modified",
            EventKind::Remove(_) => "deleted",
            _ => "changed",
        }
        .to_string();
        let _ = app.emit(
            "workspace-event",
            WorkspaceEvent {
                relative_path,
                kind,
                hash,
            },
        );
    }
}

fn lock_error<T>(err: std::sync::PoisonError<T>) -> String {
    format!("internal state lock poisoned: {err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_parent_traversal() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert!(safe_join(&root, "../outside.md").is_err());
    }

    #[test]
    fn safe_join_rejects_absolute_path() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert!(safe_join(&root, "/tmp/outside.md").is_err());
    }

    #[test]
    fn safe_join_accepts_nested_workspace_path() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let path = safe_join(&root, "src/lib.rs").unwrap();
        assert!(path.starts_with(root));
        assert!(path.ends_with("src/lib.rs"));
    }

    #[test]
    fn markdown_detection_accepts_expected_extensions() {
        assert!(is_markdown_file(Path::new("README.md")));
        assert!(is_markdown_file(Path::new("notes.markdown")));
        assert!(is_markdown_file(Path::new("doc.mdx")));
        assert!(!is_markdown_file(Path::new("main.rs")));
    }
}
