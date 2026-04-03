import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { GEMINI_API_KEY } from './config.js';
import { logger } from './logger.js';

const MODEL = 'gemini-2.5-flash';

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
  if (!GEMINI_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  return genAI;
}

export interface ExtractionResult {
  summary: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Extract/summarize email content via Gemini.
 * Returns a compact summary. Falls back to original content on failure.
 */
export async function extractEmail(
  sender: string,
  subject: string,
  body: string,
  extractPrompt?: string,
): Promise<ExtractionResult | null> {
  const client = getClient();
  if (!client) return null;

  const structuredFormat = `Respond in this exact format (omit fields that don't apply):

From: <sender name and email>
Subject: <subject line>
Type: <e.g. Transaction Alert, Receipt, E-Mandate, Upcoming Debit, Newsletter, Notification, Invoice, etc.>
Status: <Completed / Upcoming / Scheduled / Pending — clearly distinguish past transactions from future/e-mandate notifications>
Date: <email date, YYYY-MM-DD HH:MM format>
Transaction Date: <actual or scheduled transaction date, YYYY-MM-DD HH:MM format>
Key Details:
- <field>: <value> (list all important data points: amounts, names, account numbers, dates, reference IDs, merchant names)
Action Required: <None / specific action needed>
Summary: <1-2 sentence plain English summary. For e-mandate/upcoming debits, clearly state this is a FUTURE scheduled transaction, not a completed one.>`;

  const prompt = extractPrompt
    ? `Extract the following from this email:\n${extractPrompt}\n\n${structuredFormat}\n\nEmail from: ${sender}\nSubject: ${subject}\n\n${body}`
    : `${structuredFormat}\n\nEmail from: ${sender}\nSubject: ${subject}\n\n${body}`;

  try {
    const model = client.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      summary: `[Email from ${sender}] Subject: ${subject}\n\n${text}`,
      inputTokens: usage?.promptTokenCount || 0,
      outputTokens: usage?.candidatesTokenCount || 0,
      model: MODEL,
    };
  } catch (err) {
    logger.error({ err, subject }, 'Gemini email extraction failed');
    return null;
  }
}

/**
 * Extract/describe image content via Gemini vision.
 * Returns a text description. Falls back to null on failure.
 */
export async function extractImage(
  imagePath: string,
): Promise<ExtractionResult | null> {
  const client = getClient();
  if (!client) return null;

  if (!fs.existsSync(imagePath)) {
    logger.warn({ imagePath }, 'Image file not found for extraction');
    return null;
  }

  try {
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/jpeg';

    const model = client.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent([
      {
        inlineData: { mimeType, data: base64 },
      },
      "Describe this image concisely. If it contains data (numbers, text, tables, charts), extract all key information. If it's a screenshot, describe what's shown. Keep it under 300 words.",
    ]);

    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      summary: text,
      inputTokens: usage?.promptTokenCount || 0,
      outputTokens: usage?.candidatesTokenCount || 0,
      model: MODEL,
    };
  } catch (err) {
    logger.error({ err, imagePath }, 'Gemini image extraction failed');
    return null;
  }
}

/**
 * Extract/summarize PDF content.
 * Uses pdftotext locally, then Gemini to summarize.
 */
export async function extractPdf(
  pdfPath: string,
): Promise<ExtractionResult | null> {
  const client = getClient();
  if (!client) return null;

  if (!fs.existsSync(pdfPath)) {
    logger.warn({ pdfPath }, 'PDF file not found for extraction');
    return null;
  }

  // Step 1: Extract text via pdftotext
  let rawText: string;
  try {
    rawText = execFileSync('pdftotext', [pdfPath, '-'], {
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();
  } catch (err) {
    logger.error({ err, pdfPath }, 'pdftotext failed');
    return null;
  }

  if (!rawText) {
    logger.warn({ pdfPath }, 'PDF has no extractable text');
    return null;
  }

  // Step 2: Summarize via Gemini
  // Truncate very long PDFs to avoid hitting token limits
  const truncated =
    rawText.length > 30000
      ? rawText.slice(0, 30000) + '\n\n[...truncated]'
      : rawText;

  try {
    const model = client.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(
      `Summarize this document concisely. Extract all key information (names, amounts, dates, figures, action items). Keep it under 400 words.\n\n${truncated}`,
    );

    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      summary: text,
      inputTokens: usage?.promptTokenCount || 0,
      outputTokens: usage?.candidatesTokenCount || 0,
      model: MODEL,
    };
  } catch (err) {
    logger.error({ err, pdfPath }, 'Gemini PDF extraction failed');
    return null;
  }
}

/**
 * Check if extraction is available (API key configured).
 */
export function isExtractionAvailable(): boolean {
  return !!GEMINI_API_KEY;
}
