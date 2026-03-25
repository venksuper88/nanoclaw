import type { IncomingMessage } from 'http';
import type { Request } from 'express';
import crypto from 'crypto';

import { DASHBOARD_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import {
  deleteDashboardToken,
  getAllDashboardTokens,
  getDashboardToken,
  insertDashboardToken,
} from '../db.js';

export interface TokenUser {
  token: string;
  name: string;
  role: string;
  allowedGroups: string[]; // JIDs, empty = all (owner)
  canSend: boolean;
  isOwner: boolean;
  createdAt: string;
}

/**
 * Seed the owner token on startup if it doesn't already exist.
 * Call this once from main() after initDatabase().
 */
export async function initDashboardTokens(): Promise<void> {
  if (!DASHBOARD_TOKEN) return;
  const existing = await getDashboardToken(DASHBOARD_TOKEN);
  if (!existing) {
    await insertDashboardToken({
      token: DASHBOARD_TOKEN,
      name: 'Venky',
      role: 'owner',
      allowed_groups: '[]',
      can_send: 1,
      is_owner: 1,
      created_at: new Date().toISOString(),
    });
    logger.info('Owner token registered in dashboard_tokens');
  }
}

/**
 * Look up a token and return the user, or null if invalid.
 */
export async function resolveToken(token: string): Promise<TokenUser | null> {
  if (!token) return null;
  const row = await getDashboardToken(token);
  if (!row) return null;
  return {
    token: row.token,
    name: row.name,
    role: row.role,
    allowedGroups: JSON.parse(row.allowed_groups || '[]'),
    canSend: row.can_send === 1,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
  };
}

/**
 * Check if a user can access a specific group JID.
 */
export function canAccessGroup(user: TokenUser, jid: string): boolean {
  if (user.isOwner || user.allowedGroups.length === 0) return true;
  return user.allowedGroups.includes(jid);
}

/**
 * Create a new token for a user.
 */
export async function createToken(
  name: string,
  role: string,
  allowedGroups: string[],
  canSend: boolean,
): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await insertDashboardToken({
    token,
    name,
    role,
    allowed_groups: JSON.stringify(allowedGroups),
    can_send: canSend ? 1 : 0,
    is_owner: 0,
    created_at: new Date().toISOString(),
  });
  return token;
}

/**
 * List all tokens (owner only).
 */
export async function listTokens(): Promise<TokenUser[]> {
  const rows = await getAllDashboardTokens();
  return rows.map((r) => ({
    token: r.token,
    name: r.name,
    role: r.role,
    allowedGroups: JSON.parse(r.allowed_groups || '[]'),
    canSend: r.can_send === 1,
    isOwner: r.is_owner === 1,
    createdAt: r.created_at,
  }));
}

/**
 * Delete a token (cannot delete owner tokens).
 */
export async function deleteToken(token: string): Promise<boolean> {
  const existing = await getDashboardToken(token);
  if (!existing || existing.is_owner === 1) return false;
  await deleteDashboardToken(token);
  return true;
}

/**
 * Extract token from request and resolve user.
 */
export async function getRequestUser(req: Request): Promise<TokenUser | null> {
  // Check Authorization header first
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return resolveToken(auth.slice(7));
  // Fallback to query param (for img/video src URLs)
  const qToken = req.query.token;
  if (typeof qToken === 'string') return resolveToken(qToken);
  return null;
}

/**
 * Validate an HTTP request's bearer token.
 */
export async function isAuthenticated(req: IncomingMessage): Promise<boolean> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  return (await resolveToken(auth.slice(7))) !== null;
}

/**
 * Validate a socket.io handshake token.
 */
export async function isSocketAuthenticated(
  token: string,
): Promise<TokenUser | null> {
  return resolveToken(token);
}
