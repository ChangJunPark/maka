# Maka

Maka is a local-folder Markdown desktop editor built with Tauri, React, and TypeScript.

## MVP Scope

- Open a real local folder.
- Browse Markdown files.
- Edit Markdown with a source editor and live preview.
- Autosave changes.
- Detect external file changes and show a conflict banner when local edits would be overwritten.
- Render Mermaid code blocks.
- Run a VS Code-like integrated terminal rooted at the opened folder.

## Development

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm typecheck
pnpm test
cargo check --manifest-path src-tauri/Cargo.toml
```

Run the desktop app:

```bash
pnpm tauri dev
```
