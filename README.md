# Maka

Maka is a local-folder Markdown desktop editor built with Tauri, React, and TypeScript.

## Current Scope

- Open a real local folder and remember the last workspace on restart.
- Browse Markdown files while ignoring heavy/generated folders like `.git`, `node_modules`, `target`, `dist`, `.next`, `.turbo`, and `.vite`.
- Create, rename, delete, open, edit, and save Markdown files under the opened workspace.
- Edit Markdown with a source editor and live preview.
- Switch between split, editor-only, and preview-only layouts.
- Use basic writing shortcuts and toolbar actions for headings, bold, italic, inline code, and links.
- Autosave changes and support manual save with `Cmd+S`.
- Detect external file changes and show a conflict banner when local edits would be overwritten.
- Render Mermaid code blocks lazily so Mermaid loads only when a diagram appears.
- Scroll the preview in sync with the editor.
- Run a VS Code-like integrated terminal rooted at the opened folder.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd+O` | Open workspace folder |
| `Cmd+N` | Create a new Markdown file |
| `Cmd+S` | Save the active file |
| `Cmd+B` | Bold selected text |
| `Cmd+I` | Italicize selected text |
| `Cmd+K` | Insert Markdown link syntax |

## Development

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm lint
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm build
```

Run the desktop app:

```bash
pnpm tauri dev
```

Prepare a deterministic smoke-test workspace:

```bash
pnpm smoke:workspace
```

This prints the workspace path, normally `/tmp/maka-smoke-workspace`.

Build the macOS app bundle:

```bash
pnpm tauri build
```

The macOS bundle is created at:

```text
src-tauri/target/release/bundle/macos/Maka.app
```

Open the latest release bundle directly:

```bash
pnpm app:open-release
```

If an older DMG-mounted Maka is already running from `/Volumes/.../Maka.app`, close it first or run:

```bash
MAKA_KILL_STALE=1 pnpm app:open-release
```

This avoids macOS LaunchServices reactivating an old app while testing the latest build.

## Manual Smoke Checklist

Use the deterministic smoke workspace unless testing a specific user folder.

1. Run `pnpm smoke:workspace` and note the printed path.
2. Launch `pnpm tauri dev` for development or `pnpm app:open-release` for the latest built bundle.
3. Open `/tmp/maka-smoke-workspace` or the printed workspace path.
4. Confirm the file tree lists `README.md`, `diagrams/flow.md`, and `notes/todo.md`, while skipping ignored `node_modules` and `target` Markdown files.
5. Create a new Markdown file with the `+` button, empty-state action, or `Cmd+N`.
6. Rename the new file and confirm it remains open.
7. Edit the file and confirm autosave writes to disk.
8. Press `Cmd+S` and confirm the status returns to clean.
9. Modify a clean file externally and confirm Maka reloads it.
10. Modify a dirty file externally and confirm the conflict banner appears.
11. Render a Mermaid fenced block in preview.
12. Scroll the editor and confirm preview follows roughly the same position.
13. Start the terminal and run `pwd`; confirm it is rooted at the workspace.
14. Delete a test file from Maka and confirm it disappears from the tree.
15. Restart the app and confirm the last workspace is restored.
