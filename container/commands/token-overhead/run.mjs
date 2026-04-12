import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const group = input.group || process.env.NANOCLAW_GROUP_FOLDER || '';
const SESSION_DIR = join(PROJECT_ROOT, 'data', 'sessions', group);
const HOME = homedir();

// Read group config from dashboard API to get disabledTools and allowedSkills
let groupDisabledTools = [];
let groupAllowedSkills = [];
const dashPort = process.env.DASHBOARD_PORT || '3002';
const dashToken = process.env.DASHBOARD_TOKEN || '';
if (group && dashToken) {
  try {
    // Find the JID for this group folder
    const groupsResp = await fetch(`http://localhost:${dashPort}/api/groups?token=${dashToken}`);
    if (groupsResp.ok) {
      const groupsJson = await groupsResp.json();
      const match = (groupsJson.data || []).find(g => g.folder === group);
      if (match) {
        const settingsResp = await fetch(`http://localhost:${dashPort}/api/groups/${encodeURIComponent(match.jid)}/settings?token=${dashToken}`);
        if (settingsResp.ok) {
          const settingsJson = await settingsResp.json();
          if (settingsJson.ok && settingsJson.data) {
            groupDisabledTools = settingsJson.data.disabledTools || [];
            groupAllowedSkills = settingsJson.data.allowedSkills || [];
          }
        }
      }
    }
  } catch {}
}
const disabledToolsSet = new Set(groupDisabledTools);
const allowedSkillsSet = new Set(groupAllowedSkills);

// ~4 chars per token (rough estimate for English text + markdown)
function estimateTokens(chars) {
  return Math.round(chars / 4);
}

function fileSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

function fileTokens(p) {
  const size = fileSize(p);
  return { size, tokens: estimateTokens(size) };
}

const items = [];
let totalTokens = 0;

function add(category, name, filePath) {
  const { size, tokens } = fileTokens(filePath);
  if (size > 0) {
    items.push({ category, name, size, tokens });
    totalTokens += tokens;
  }
}

// 1. Root CLAUDE.md
add('Root CLAUDE.md', 'CLAUDE.md', join(PROJECT_ROOT, 'CLAUDE.md'));

// 2. User CLAUDE.md (~/.claude/)
const userClaudeMd = join(HOME, '.claude', 'CLAUDE.md');
if (existsSync(userClaudeMd)) {
  add('User CLAUDE.md', '~/.claude/CLAUDE.md', userClaudeMd);
  // Check for @includes (like @RTK.md)
  try {
    const content = readFileSync(userClaudeMd, 'utf-8');
    const includes = content.match(/^@(\S+\.md)$/gm);
    if (includes) {
      for (const inc of includes) {
        const incFile = inc.slice(1); // remove @
        const incPath = join(HOME, '.claude', incFile);
        add('User CLAUDE.md', `~/.claude/${incFile} (included)`, incPath);
      }
    }
  } catch {}
}

// 3. Group CLAUDE.md
if (group) {
  add('Group CLAUDE.md', `groups/${group}/CLAUDE.md`, join(PROJECT_ROOT, 'groups', group, 'CLAUDE.md'));
}

// 4. Rules file
add('Rules', 'container/rules.md', join(PROJECT_ROOT, 'container', 'rules.md'));

// 5. Skills — only name + description (frontmatter) are loaded at startup (deferred).
//    Full SKILL.md is only loaded when the skill is actually invoked.
const skillsDir = join(SESSION_DIR, '.claude', 'skills');
if (existsSync(skillsDir)) {
  try {
    const skills = readdirSync(skillsDir).sort();
    let skillOverheadAdded = false;
    for (const skill of skills) {
      const skillMd = join(skillsDir, skill, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      // Skip skills not in allowedSkills (if allowedSkills is set)
      if (allowedSkillsSet.size > 0 && !allowedSkillsSet.has(skill)) continue;
      const content = readFileSync(skillMd, 'utf-8');
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      let desc = '';
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        if (descMatch) desc = descMatch[1].trim().replace(/^["']|["']$/g, '');
      }
      const entryChars = `- ${skill}: ${desc}\n`.length;
      const entryTokens = estimateTokens(entryChars);
      items.push({ category: 'Skills (deferred — name+desc only)', name: skill, size: entryChars, tokens: entryTokens });
      totalTokens += entryTokens;
    }
  } catch {}
}

// 6. Auto-memory — check per-group dir first, fallback to shared project dir
const perGroupMemDir = join(HOME, '.claude', 'agent-memory', group);
const sharedMemDir = join(HOME, '.claude', 'projects', '-Users-deven-Projects-nanoclaw', 'memory');
const memoryDir = existsSync(perGroupMemDir) ? perGroupMemDir : sharedMemDir;
const memLabel = existsSync(perGroupMemDir) ? `Auto-Memory (${group})` : 'Auto-Memory (shared — all agents)';
if (existsSync(memoryDir)) {
  const memIndex = join(memoryDir, 'MEMORY.md');
  add(memLabel, 'MEMORY.md (index)', memIndex);
  try {
    const memFiles = readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').sort();
    for (const mf of memFiles) {
      add(memLabel, mf, join(memoryDir, mf));
    }
  } catch {}
}

// 7. MCP Tools — tool schemas are injected into context at session start
const mcpConfigPath = join(SESSION_DIR, '.claude', 'mcp-config.json');
if (existsSync(mcpConfigPath)) {
  try {
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    const servers = mcpConfig.mcpServers || {};
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (serverName === 'nanoclaw') {
        const srcFile = join(PROJECT_ROOT, 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts');
        if (!existsSync(srcFile)) continue;
        const src = readFileSync(srcFile, 'utf-8');
        // Use DB-sourced disabled tools (current state) instead of stale mcp-config.json
        const disabledSet = disabledToolsSet;

        // Parse individual tool() blocks: extract name, description, and schema
        const lines = src.split('\n');
        let inTool = false;
        let toolBlock = '';
        let depth = 0;
        const toolBlocks = [];

        for (const line of lines) {
          if (/^tool\(/.test(line)) {
            inTool = true;
            toolBlock = '';
            depth = 0;
          }
          if (inTool) {
            toolBlock += line + '\n';
            // Track parentheses depth to find matching close
            for (const ch of line) {
              if (ch === '(') depth++;
              if (ch === ')') depth--;
            }
            if (depth === 0 && toolBlock.length > 0) {
              inTool = false;
              toolBlocks.push(toolBlock);
            }
          }
        }

        for (const block of toolBlocks) {
          // Extract tool name from first string argument
          const nameMatch = block.match(/tool\(\s*\n?\s*'([^']+)'/);
          if (!nameMatch) continue;
          const toolName = nameMatch[1];
          // Skip disabled tools entirely
          if (disabledSet.has(toolName)) continue;

          // Extract description (second string argument) and schema portion
          // Schema chars = name + description + zod params (exclude async handler body)
          const handlerIdx = block.indexOf('async (');
          const schemaSource = handlerIdx > 0 ? block.slice(0, handlerIdx) : block;
          // JSON schema is ~80% of the source schema portion
          const schemaChars = Math.round(schemaSource.length * 0.8);
          const tokens = estimateTokens(schemaChars);
          items.push({ category: 'MCP Tools (nanoclaw)', name: toolName, size: schemaChars, tokens });
          totalTokens += tokens;
        }
      } else {
        items.push({
          category: 'MCP Tools (external)',
          name: `${serverName} (token count unknown)`,
          size: 0,
          tokens: 0,
        });
      }
    }
  } catch {}
}

// 8. Claude Code built-in tools (Read, Write, Edit, Bash, Grep, Glob, Agent, TodoWrite, etc.)
// These are fixed-cost tool schemas baked into every session — ~12 tools, ~8K tokens estimated
items.push({
  category: 'Built-in Tools',
  name: 'Claude Code tools (~12 tools, fixed cost)',
  size: 32000,
  tokens: 8000,
});
totalTokens += 8000;

// 9. System prompt (Claude Code's base instructions — fixed cost)
// Estimated ~4K tokens for the base system prompt before any project-specific content
items.push({
  category: 'System Prompt',
  name: 'Claude Code base instructions (fixed cost)',
  size: 16000,
  tokens: 4000,
});
totalTokens += 4000;

// 10. Settings.json (MCP config etc.)
add('Config', 'settings.json', join(SESSION_DIR, '.claude', 'settings.json'));

// Format output
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

let out = `*Token Overhead — ${group || 'unknown'}*\n\n`;

let currentCat = '';
for (const item of items) {
  if (item.category !== currentCat) {
    currentCat = item.category;
    out += `\n*${currentCat}*\n`;
  }
  out += `  ${item.name}  ${fmtSize(item.size)}  (~${item.tokens.toLocaleString()} tok)\n`;
}

// Category subtotals
const cats = {};
for (const item of items) {
  cats[item.category] = (cats[item.category] || 0) + item.tokens;
}

out += `\n*Summary*\n`;
for (const [cat, toks] of Object.entries(cats)) {
  out += `  ${cat}: ~${toks.toLocaleString()} tokens\n`;
}
out += `  ——————————\n`;
out += `  *Total: ~${totalTokens.toLocaleString()} tokens*\n`;

process.stdout.write(JSON.stringify({ message: out }));
