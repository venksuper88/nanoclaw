---
name: create-claude-md
description: Creates well-structured CLAUDE.md files for any project following official best practices. Use when the user asks to create a CLAUDE.md, set up project instructions, configure Claude Code for a repo, or initialize project context.
---

# Create CLAUDE.md

Guide for creating effective CLAUDE.md files that give Claude the context it needs without wasting tokens.

## Workflow

Copy and track progress:
- [ ] Step 1: Analyze the project
- [ ] Step 2: Ask targeted questions
- [ ] Step 3: Generate the CLAUDE.md
- [ ] Step 4: Review with user and iterate

### Step 1: Analyze the Project

Scan the repo to understand what you're working with:

1. **Read the manifest** — `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.
2. **Scan directory structure** — `ls` the top-level and key subdirectories
3. **Check for existing docs** — README, CONTRIBUTING, existing CLAUDE.md, `.editorconfig`
4. **Read build config** — `tsconfig.json`, `Makefile`, `Dockerfile`, CI config
5. **Identify the stack** — language, framework, database, deploy target
6. **Check for tests** — find the test runner, test directory, and how to run a single test

### Step 2: Ask Targeted Questions

After analysis, ask the user 3-5 questions about things you **cannot** determine from code:

- "What's the one thing that always trips up new contributors?"
- "Are there any commands that look like they should work but don't?"
- "What decisions were made that aren't obvious from the code?"
- "Are there files or patterns that seem wrong but are intentional?"
- "What's the deploy process and are there any gotchas?"

**Do NOT ask** about things you already found in the code.

### Step 3: Generate the CLAUDE.md

Follow the structure and principles below. Write it, then present it to the user.

### Step 4: Review and Iterate

Ask: "What's missing? What's wrong? What would you add for a new teammate?"

Iterate until the user is satisfied.

## CLAUDE.md Structure

Follow this order — most universally useful information first:

```markdown
# Project Name

One-line summary: what it is, what language/framework, what it does.

## Commands

| Task | Command |
|------|---------|
| Build | `npm run build` |
| Test (all) | `npm test` |
| Test (single) | `npm test -- path/to/test` |
| Lint | `npm run lint` |
| Dev server | `npm run dev` |
| Deploy | `./deploy.sh staging` |

## Architecture

Brief description of how the system is organized.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, server setup |
| `src/db.ts` | Database connection and queries |
| `src/routes/` | API route handlers |

## Code Style

- Naming conventions, import order, patterns
- Framework-specific conventions

## Rules

- **NEVER** do X because Y
- **ALWAYS** do Z when W
- Gotchas and anti-patterns
```

## Principles

### 1. Be Specific, Not Generic

**Bad:** "Follow the design system"
**Good:** "Use Manrope for headings at 800 weight, 22px. Body text is Inter. Primary color is `var(--purple)` #6C3CE1."

### 2. Encode Tribal Knowledge

Document the things that aren't obvious from reading code:

- Why a seemingly wrong pattern is intentional
- What breaks if you change a particular file
- Environment quirks ("tests fail on CI if X env var is missing")
- Historical decisions ("we use library X instead of Y because Z")

### 3. Commands Over Descriptions

**Bad:** "Run the test suite to verify changes"
**Good:** `npm test -- --coverage --watchAll=false`

### 4. Anti-Patterns Over Patterns

Claude defaults to common patterns. Telling it what NOT to do is often more valuable:

- **"NEVER use `var(--accent)`"** — prevents a plausible-looking mistake
- **"Do NOT use `fs.readFileSync` in request handlers"** — prevents a common default

### 5. Keep It Under 500 Lines

CLAUDE.md loads every conversation. Every line competes with user context. If it's obvious from the code, don't document it. If it's a full API reference, link to it instead.

### 6. Update Continuously

CLAUDE.md is a living document. When Claude makes a mistake, add a rule. When a pattern is established, document it. When a gotcha is discovered, record it.

## What to Include

- **Project identity** — 1-2 lines: name, language, purpose
- **Build/test/lint commands** — exact, copy-pasteable syntax
- **Key file map** — file path to purpose, as a table
- **Architecture decisions** — constraints, patterns, why things are the way they are
- **Code conventions** — naming, imports, patterns specific to this project
- **Common gotchas** — things that break, non-obvious behaviors
- **Development workflow** — PR process, branch strategy, deploy steps

## What NOT to Include

- Generic programming advice Claude already knows
- Entire API documentation (link to it instead)
- Change logs or version history (that's git)
- Secrets, credentials, or API keys
- Language tutorials

## Format Tips

- **Tables** for commands and file maps — scannable at a glance
- **Code blocks** for exact commands — copy-pasteable
- **Bold** for NEVER and ALWAYS rules — they stand out
- **Most-referenced info at the top** — commands and architecture before style rules

## Hierarchy

CLAUDE.md files can exist at multiple levels. Claude merges them top-down:

| Location | Scope | Example Use |
|----------|-------|-------------|
| `~/.claude/CLAUDE.md` | All projects | Personal preferences, global rules |
| `./CLAUDE.md` | This repo | Project commands, architecture, conventions |
| `./src/CLAUDE.md` | Subdirectory | Module-specific patterns |

Child files override parent files. Keep repo-level CLAUDE.md self-contained.
