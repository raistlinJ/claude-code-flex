# Contributing to Claude Code WebUI

Thanks for contributing.

## Development Setup

1. Install dependencies:

```bash
npm run install:all
```

2. Generate local TLS certs:

```bash
cd server
./generate-certs.sh
cd ..
```

3. Run the app:

```bash
npm run dev
```

For LAN/mobile testing, run the client on all interfaces:

```bash
npm --prefix client run dev -- --host 0.0.0.0
```

## Branch and PR Workflow

1. Create a feature branch from main.
2. Keep changes focused and small.
3. Run a quick manual check in desktop and mobile views for UI changes.
4. Open a pull request with:
- What changed
- Why it changed
- How it was tested

## Code Style

- Follow existing file structure and naming.
- Avoid unrelated refactors in feature or bug-fix PRs.
- Keep comments minimal and only for non-obvious constraints.

## Security and Local-Only Defaults

This project is development-focused by default. Before production use, review:

- CORS policy
- TLS/certificate handling
- Permission bypass options
- Stored secrets and config files

## Reporting Issues

Open an issue in the GitHub repository with:

- Steps to reproduce
- Expected result
- Actual result
- Logs/screenshots when relevant
