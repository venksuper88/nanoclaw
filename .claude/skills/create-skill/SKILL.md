---
name: create-skill
description: Creates well-structured Claude Code skills following official best practices. Use when the user asks to create a new skill, write a SKILL.md, or package instructions as a reusable skill.
---

# Create Skill

Guide for creating Claude Code skills that follow Anthropic's official best practices.

## Workflow

1. **Understand the purpose** — Ask: What does this skill do? When should Claude trigger it?
2. **Choose content strategy** — Instructions only? With scripts? With reference files?
3. **Write the skill** — Follow the structure and rules below
4. **Review** — Run through the [checklist](references/checklist.md) before shipping

## Skill Location

All skills go in `.claude/skills/<skill-name>/SKILL.md`

## SKILL.md Format

```yaml
---
name: lowercase-with-hyphens
description: Third-person description of what the skill does AND when to use it. Include trigger keywords.
---

# Skill Title

[Instructions here]
```

### Frontmatter Rules

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | yes | Max 64 chars, lowercase + numbers + hyphens only. No "anthropic" or "claude" |
| `description` | yes | Max 1024 chars, third-person, no XML tags |

### Description is Critical

Claude uses description to pick the right skill from 100+ available. It must include:
- **What** the skill does
- **When** to trigger it (keywords, trigger phrases)

**Good**: `"Queries Tenjin UA analytics API — spend, revenue, ad revenue, cohort LTV, retention. Use when the user asks about UA performance, spend, ROAS, LTV, ad revenue, or install metrics."`

**Bad**: `"Helps with analytics data"`

## Core Principles

### 1. Claude is Already Smart

Only add context Claude doesn't already have. Challenge every line:
- "Does Claude need this explanation?"
- "Can I assume Claude knows this?"
- "Does this paragraph justify its token cost?"

### 2. Concise is Key

Context window is shared with conversation history, other skills, and system prompt. Every token competes. 50 clear tokens beats 150 verbose tokens.

### 3. Match Freedom to Fragility

| Situation | Freedom Level | Format |
|-----------|--------------|--------|
| Multiple valid approaches | High | Text guidance |
| Preferred pattern, some variation OK | Medium | Pseudocode/templates |
| Fragile/critical operations | Low | Exact scripts, no deviation |

### 4. Keep Body Under 500 Lines

If approaching the limit, split into reference files.

## Progressive Disclosure

Skills load in 3 levels — design for this:

| Level | When Loaded | Token Cost |
|-------|------------|------------|
| **Metadata** | Always (startup) | ~100 tokens |
| **SKILL.md body** | When triggered | < 5k tokens |
| **Reference files** | As needed | Unlimited |

**Key insight**: Bundle extensive reference material freely — zero context cost until accessed.

## File Organization

```
skill-name/
├── SKILL.md              # Main instructions (< 500 lines)
├── REFERENCE.md          # Detailed docs (loaded as needed)
├── references/           # Domain-specific files
│   ├── api.md
│   └── examples.md
└── scripts/
    └── helper.py         # Executed, not loaded into context
```

### Rules

- **References one level deep only** — SKILL.md links to files, never file-to-file chains
- **Name files descriptively** — `form_validation_rules.md` not `doc2.md`
- **100+ line reference files** need a table of contents at top
- **Forward slashes only** — `scripts/helper.py` not `scripts\helper.py`

## Content Guidelines

- **No time-sensitive info** — no "before August 2025 use X"
- **Consistent terminology** — pick one term per concept
- **One default approach** — don't offer 5 options, give the best one with an escape hatch
- **Concrete examples** — input/output pairs, not abstract descriptions

## Workflows

For complex multi-step tasks, provide numbered steps with a copyable checklist:

```markdown
## Workflow

Copy and track progress:
- [ ] Step 1: Analyze input
- [ ] Step 2: Generate output
- [ ] Step 3: Validate result
```

Include **feedback loops** for quality-critical tasks: validate → fix → re-validate.

## Scripts

When including executable scripts:
- Scripts save tokens — only output enters context, not source code
- Handle errors explicitly in scripts, don't punt to Claude
- No magic numbers — document every constant
- State execution intent: "Run `script.py`" (execute) vs "See `script.py`" (read)

## Pre-Ship Checklist

See [references/checklist.md](references/checklist.md) for the full checklist.

Quick version:
1. Description is specific with trigger keywords, in third person
2. Body < 500 lines
3. No deeply nested references
4. Consistent terminology
5. Concrete examples
6. Tested with real scenarios
