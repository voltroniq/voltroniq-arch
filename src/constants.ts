// Shared configuration for file scanning and watching.

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target",
  "coverage", ".archeologist", ".next", ".venv", "venv", "__pycache__"
])

export const SKIP_EXTENSIONS = [".min.js", ".min.ts", ".bundle.js"]

export const LANGUAGE_BY_EXT: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mjs": "javascript",
  ".cjs": "javascript",
}