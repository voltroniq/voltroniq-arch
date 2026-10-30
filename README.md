# voltroniq-arch

> **Status: Pre-alpha (active development).** Parser works for single
> JavaScript files; CLI and repository indexing coming next.

A local-first code intelligence tool for legacy and unfamiliar codebases.

## What works today

- Tree-sitter–based parsing of a single JavaScript file
- Extracts function declarations, classes, methods, and arrow functions
- Ignores function-like text inside strings and comments (the regex killer)
- Prints name, kind, and line number for each symbol
- 5 passing tests

## What's coming

- TypeScript and JSX support
- SQLite index + `scan` command (index an entire folder)
- `search` command (query symbols across a repo)
- MCP server for Cursor / Claude Desktop

## Try it

    git clone git@github.com:voltroniq/voltroniq-arch.git
    cd voltroniq-arch
    npm install

Put a JavaScript file named `input.js` in the repo root, then run:

    npm run dev

Example output:

    Found 3 symbol(s):
      function hello (line 1)
      function greet (line 5)
      class    Foo (line 7)

## Known limitations

- Only reads `input.js` from the current directory (CLI arguments in the next lesson)
- JavaScript only — TypeScript, Python, and other languages planned
- No persistence — parses on each run, doesn't store an index

## Development

    npm test               # run tests
    npx tsc --noEmit       # type-check
    npm run dev            # run the parser on ./input.js

## License

MIT