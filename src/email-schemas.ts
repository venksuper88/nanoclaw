import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { EmailSchemaDefinition } from './types.js';

/**
 * Load all email schemas from groups/{folder}/email-schemas.json.
 * Reads from disk on every call — the files are tiny and this only runs per email.
 */
export function loadEmailSchemas(): EmailSchemaDefinition[] {
  const schemas: EmailSchemaDefinition[] = [];
  const seenTypes = new Set<string>();

  try {
    const groupDirs = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    for (const dir of groupDirs) {
      if (!dir.isDirectory()) continue;
      const schemaPath = path.join(GROUPS_DIR, dir.name, 'email-schemas.json');
      if (!fs.existsSync(schemaPath)) continue;

      try {
        const raw = fs.readFileSync(schemaPath, 'utf-8');
        const defs = JSON.parse(raw) as EmailSchemaDefinition[];
        if (!Array.isArray(defs)) {
          logger.warn(
            { folder: dir.name },
            'email-schemas.json is not an array',
          );
          continue;
        }
        for (const def of defs) {
          if (!def.type || !def.classificationPrompt || !def.fields) {
            logger.warn(
              { folder: dir.name, type: def.type },
              'Invalid email schema — missing required fields',
            );
            continue;
          }
          if (seenTypes.has(def.type)) {
            logger.debug(
              { folder: dir.name, type: def.type },
              'Duplicate email schema type, skipping',
            );
            continue;
          }
          seenTypes.add(def.type);
          schemas.push(def);
        }
        logger.debug(
          { folder: dir.name, count: defs.length },
          'Loaded email schemas',
        );
      } catch (err) {
        logger.warn(
          { err, folder: dir.name },
          'Failed to parse email-schemas.json',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to scan groups for email schemas');
  }

  return schemas;
}

/**
 * Build the Gemini classification prompt from all registered schemas.
 */
export function buildClassificationPrompt(
  schemas: EmailSchemaDefinition[],
): string {
  const typeList = schemas
    .map((s) => `- ${s.type}: ${s.description}`)
    .join('\n');
  const typeNames = schemas.map((s) => s.type);

  // Build per-type classification guidance
  const classificationGuidance = schemas
    .map((s) => `### ${s.type}\n${s.classificationPrompt}`)
    .join('\n\n');

  // Build per-type extraction schemas
  const extractionSchemas = schemas
    .map((s) => {
      const mandatory = Object.entries(s.fields.mandatory)
        .map(([k, v]) => `  - ${k} (MANDATORY): ${v}`)
        .join('\n');
      const optional = Object.entries(s.fields.optional)
        .map(([k, v]) => `  - ${k}: ${v} (use "NA" if not available)`)
        .join('\n');
      return `### ${s.type}\nMandatory fields:\n${mandatory}\nOptional fields:\n${optional}`;
    })
    .join('\n\n');

  return `You are an email classification and extraction engine. Respond ONLY with valid JSON, no markdown fences.

Step 1: Classify this email into one of these types:
${typeList}
- Other: Does not fit any of the above types

Classification guidance:
${classificationGuidance}

Step 2: If the email matches a type with a schema (not "Other"), extract structured data into the "data" field. For fields where information is not available, use "NA" for strings, 0 for numbers, and false for booleans.

Extraction schemas:
${extractionSchemas}

Step 3: Write a 1-2 sentence plain English summary.

For "Other" type, set "data" to null.

Response format:
{"emailType": "${typeNames[0] || 'Other'}" | "${typeNames.slice(1).join('" | "')}" | "Other", "summary": "...", "data": {...} or null}`;
}

/** Get all registered email type names (for UI dropdowns etc.) */
export function getRegisteredEmailTypes(): string[] {
  const schemas = loadEmailSchemas();
  return [...schemas.map((s) => s.type), 'Other'];
}
