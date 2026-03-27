# Skill Examples

## Good: API Reference Skill (instruction-only)

```yaml
---
name: tenjin
description: Queries Tenjin UA analytics API — spend, revenue, ad revenue, cohort LTV, retention. Use when the user asks about UA performance, spend, ROAS, LTV, ad revenue, or install metrics.
---

# Tenjin API

## Auth
[token path and curl pattern]

## Endpoints
[endpoint table with params]

## Gotchas
[numbered list of traps]

## Common Queries
[ready-to-use curl examples]
```

**Why it works**: Concise, all gotchas upfront, ready-to-use examples. No explanation of what an API is.

## Good: Domain-Organized Skill (with references)

```
bigquery-skill/
├── SKILL.md           # Overview + navigation
└── reference/
    ├── finance.md     # Revenue, billing
    ├── sales.md       # Pipeline, accounts
    └── product.md     # API usage, features
```

SKILL.md points to domain files. Claude loads only the relevant one.

## Bad: Over-Explained Skill

```yaml
---
name: helper
description: Helps with things
---

# Helper

PDF (Portable Document Format) is a file format created by Adobe...
There are many libraries for PDF processing...
First you need to install Python...
```

**Problems**: Vague name/description, explains things Claude already knows, wastes tokens.

## Bad: Deeply Nested References

```
SKILL.md → advanced.md → details.md → actual-info.md
```

Claude may only partially read nested files. Keep references one level deep.
