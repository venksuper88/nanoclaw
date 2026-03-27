# Pre-Ship Checklist

Run through this before shipping any skill.

## Core Quality

- [ ] `name` is lowercase-with-hyphens, max 64 chars
- [ ] `description` is third-person, includes what + when, max 1024 chars
- [ ] Description includes trigger keywords users would naturally say
- [ ] SKILL.md body is under 500 lines
- [ ] Only context Claude doesn't already know is included
- [ ] No time-sensitive information
- [ ] Consistent terminology throughout
- [ ] Examples are concrete (input/output pairs), not abstract
- [ ] One default approach per task, not multiple options
- [ ] File references are one level deep from SKILL.md
- [ ] Reference files 100+ lines have a table of contents
- [ ] All file paths use forward slashes

## If Skill Has Scripts

- [ ] Scripts handle errors explicitly (no punting to Claude)
- [ ] No magic numbers — all constants documented
- [ ] Execution intent is clear ("Run X" vs "See X")
- [ ] Required packages are listed

## If Skill Has Workflows

- [ ] Steps are numbered and sequential
- [ ] Copyable checklist provided for complex flows
- [ ] Feedback loops included for quality-critical tasks
- [ ] Conditional branching is clear (if X → do Y)

## Testing

- [ ] Tested with a real scenario (not just read-through)
- [ ] Skill triggers correctly from natural language
- [ ] Claude finds referenced files without confusion
