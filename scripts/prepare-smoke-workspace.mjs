#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const explicitPath = args.find((arg) => !arg.startsWith("--"));
const workspace = resolve(explicitPath ?? "/tmp/maka-smoke-workspace");

if (reset) {
  await rm(workspace, { recursive: true, force: true });
}

await mkdir(join(workspace, "diagrams"), { recursive: true });
await mkdir(join(workspace, "notes"), { recursive: true });
await mkdir(join(workspace, "node_modules", "ignored-package"), { recursive: true });
await mkdir(join(workspace, "target", "ignored-build"), { recursive: true });

await writeFile(
  join(workspace, "README.md"),
  `# Maka Smoke Test

이 파일은 Maka 수동 smoke test용입니다.

## 체크 항목

- 편집 후 자동저장
- 외부 변경 자동 반영
- 충돌 배너 표시
- Mermaid preview

\`\`\`mermaid
graph TD
  A[Open workspace] --> B[Edit markdown]
  B --> C[Autosave]
  C --> D[External change watch]
\`\`\`
`,
);

await writeFile(
  join(workspace, "diagrams", "flow.md"),
  `# Flow

\`\`\`mermaid
sequenceDiagram
  participant User
  participant Maka
  User->>Maka: Open folder
  User->>Maka: Edit markdown
  Maka-->>User: Autosave + preview
\`\`\`
`,
);

await writeFile(
  join(workspace, "notes", "todo.md"),
  `# Todo

- [ ] 새 파일 생성
- [ ] 이름 변경
- [ ] 삭제
- [ ] 터미널 pwd 확인
`,
);

await writeFile(join(workspace, "node_modules", "ignored-package", "hidden.md"), "# ignored\n");
await writeFile(join(workspace, "target", "ignored-build", "hidden.md"), "# ignored\n");

console.log(workspace);
