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

Build the macOS app bundle:

```bash
pnpm tauri build
```

The macOS bundle is created at:

```text
src-tauri/target/release/bundle/macos/Maka.app
```

## Manual Smoke Checklist

Use a temporary workspace folder with at least two Markdown files.

1. Launch `pnpm tauri dev`.
2. Open the temp workspace folder.
3. Confirm the file tree lists Markdown files and skips ignored folders.
4. Create a new Markdown file with the `+` button or `Cmd+N`.
5. Rename the new file and confirm it remains open.
6. Edit the file and confirm autosave writes to disk.
7. Press `Cmd+S` and confirm the status returns to clean.
8. Modify a clean file externally and confirm Maka reloads it.
9. Modify a dirty file externally and confirm the conflict banner appears.
10. Render a Mermaid fenced block in preview.
11. Scroll the editor and confirm preview follows roughly the same position.
12. Start the terminal and run `pwd`; confirm it is rooted at the workspace.
13. Delete a test file from Maka and confirm it disappears from the tree.
14. Restart the app and confirm the last workspace is restored.
