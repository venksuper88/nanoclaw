import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  EmailRule,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { extractEmail, classifyEmail } from '../extraction.js';
import { getEnabledEmailRules, logEmail } from '../db.js';
import { runCommand, resolveCommand } from '../commands.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  private userEmail = '';

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    // Verify connection
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    // Start polling with error backoff (max 5 min)
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              5 * 60 * 1000,
            )
          : this.pollIntervalMs;
      if (this.consecutiveErrors > 0) {
        logger.info(
          { consecutiveErrors: this.consecutiveErrors, nextPollMs: backoffMs },
          'Gmail polling with backoff',
        );
      }
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private buildQuery(): string {
    return 'is:unread -category:promotions -category:social -category:forums';
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      const query = this.buildQuery();
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const messages = res.data.messages || [];
      const newMessages = messages.filter(
        (m) => m.id && !this.processedIds.has(m.id),
      );

      if (newMessages.length > 0) {
        logger.info(
          { total: messages.length, new: newMessages.length },
          'Gmail poll: new messages',
        );
      } else {
        logger.debug({ total: messages.length }, 'Gmail poll: no new messages');
      }

      for (const stub of newMessages) {
        this.processedIds.add(stub.id!);
        try {
          await this.processMessage(stub.id!);
        } catch (err) {
          logger.error(
            { err, messageId: stub.id },
            'Gmail processMessage failed',
          );
        }
      }

      // Cap processed ID set to prevent unbounded growth
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        5 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Gmail poll failed',
      );
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    // Use the later of internalDate and now — forwarded/old emails have stale
    // internalDate values that fall behind the agent's cursor, causing them to
    // be invisible to getMessagesSince().
    const internalMs = parseInt(msg.data.internalDate || '0', 10);
    const timestamp = new Date(Math.max(internalMs, Date.now())).toISOString();

    // Extract sender name and email
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self (our own replies)
    if (senderEmail === this.userEmail) return;

    // Extract body text (prefer plain text, fall back to stripped HTML)
    let body = this.extractTextBody(msg.data.payload);
    if (!body) {
      const htmlBody = this.extractHtmlBody(msg.data.payload);
      if (htmlBody) body = stripHtml(htmlBody);
    }

    if (!body) {
      logger.debug({ messageId, subject }, 'Skipping email with no text body');
      return;
    }

    const chatJid = `gmail:${threadId}`;

    // Cache thread metadata for replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    // Evaluate email rules
    const { targetJid, content, action, matchedRule } =
      await this.evaluateRules(
        senderEmail,
        senderName,
        subject,
        body,
        messageId,
        threadId,
      );

    // Execute action
    if (action === 'discard') {
      logger.info(
        { messageId, subject, rule: matchedRule?.name },
        'Email discarded by rule',
      );
      await this.markRead(messageId);
      return;
    }

    if (action === 'archive') {
      logger.info(
        { messageId, subject, rule: matchedRule?.name },
        'Email archived by rule',
      );
      await this.markRead(messageId);
      return;
    }

    if (action === 'command' && matchedRule?.command_name) {
      // Execute command directly — pass full email extraction as input
      const groups = this.opts.registeredGroups();
      const targetFolder = matchedRule.target_group;
      const groupEntry = Object.entries(groups).find(
        ([, g]) => g.folder === targetFolder,
      );
      const groupJid = groupEntry ? groupEntry[0] : targetJid;

      if (resolveCommand(matchedRule.command_name, targetFolder)) {
        const sendMsg = async (text: string) => {
          this.opts.onMessage(groupJid, {
            id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            chat_jid: groupJid,
            sender: senderEmail,
            sender_name: 'Command',
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: true,
          });
        };

        runCommand({
          commandName: matchedRule.command_name,
          groupFolder: targetFolder,
          chatJid: groupJid,
          input: {
            from: senderEmail,
            fromName: senderName,
            subject,
            body,
            summary: content,
            threadId,
            messageId,
            receivedAt: new Date().toISOString(),
          },
          sendMessage: sendMsg,
        }).catch((err) =>
          logger.error(
            { err, commandName: matchedRule!.command_name },
            'Email command execution failed',
          ),
        );

        logger.info(
          {
            messageId,
            subject,
            command: matchedRule.command_name,
            rule: matchedRule.name,
          },
          'Email routed to command',
        );
        await this.markRead(messageId);
        return;
      } else {
        logger.warn(
          { commandName: matchedRule.command_name, targetFolder },
          'Email rule command not found, falling back to forward',
        );
        // Fall through to forward
      }
    }

    // Forward to target group
    this.opts.onMessage(targetJid, {
      id: messageId,
      chat_jid: targetJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    await this.markRead(messageId);

    logger.info(
      { targetJid, from: senderName, subject, rule: matchedRule?.name },
      'Gmail email delivered',
    );
  }

  private async evaluateRules(
    senderEmail: string,
    senderName: string,
    subject: string,
    body: string,
    messageId: string,
    threadId: string,
  ): Promise<{
    targetJid: string;
    content: string;
    action: EmailRule['action'];
    matchedRule: EmailRule | null;
  }> {
    const groups = this.opts.registeredGroups();

    // Default: prefer dashboard_po as the default email destination, fall back to any main group
    const poEntry = Object.entries(groups).find(
      ([, g]) => g.folder === 'dashboard_po',
    );
    const mainEntry =
      poEntry || Object.entries(groups).find(([, g]) => g.isMain === true);
    const defaultJid = mainEntry ? mainEntry[0] : '';

    // Step 1: Classify and extract structured data via Gemini
    const senderFull = `${senderName} <${senderEmail}>`;
    const classification = await classifyEmail(senderFull, subject, body);

    // Build human-readable content from classification
    let content: string;
    let emailType: string | null = null;
    let structuredData: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    if (classification) {
      const c = classification.classification;
      emailType = c.emailType;
      inputTokens = classification.inputTokens;
      outputTokens = classification.outputTokens;

      if (c.data) {
        structuredData = JSON.stringify(c.data);
      }

      // Format content for the agent
      content = `[Email from ${senderFull}] Subject: ${subject}\nType: ${c.emailType}\n\n${c.summary}`;
      if (c.data) {
        // Generic key-value formatting for any schema type
        const details = Object.entries(c.data as Record<string, unknown>)
          .filter(
            ([, v]) =>
              v !== 'NA' &&
              v !== '' &&
              v !== null &&
              v !== undefined &&
              v !== 0,
          )
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n');
        if (details) content += `\n\n${details}`;
      }
    } else {
      // Fallback to old extraction if classification fails
      const extraction = await extractEmail(senderFull, subject, body);
      if (extraction) {
        content = extraction.summary;
        inputTokens = extraction.inputTokens;
        outputTokens = extraction.outputTokens;
      } else {
        content = `[Email from ${senderFull}]\nSubject: ${subject}\n\n${body}`;
      }
    }

    // Step 2: Load and evaluate rules
    let rules: EmailRule[] = [];
    try {
      rules = await getEnabledEmailRules();
    } catch (err) {
      logger.warn({ err }, 'Failed to load email rules');
    }

    // For from_pattern, also check email body — forwarded emails embed the original sender there
    let matchedRule: EmailRule | null = null;
    for (const rule of rules) {
      // If rule has email_type_pattern, it must match the classified type
      if (rule.email_type_pattern) {
        const allowedTypes = rule.email_type_pattern
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        if (!emailType || !allowedTypes.includes(emailType.toLowerCase())) {
          continue; // type doesn't match, skip this rule
        }
      }

      // Check traditional pattern matching (from/subject/body)
      const hasPatterns =
        rule.from_pattern || rule.subject_pattern || rule.body_pattern;
      const patternMatch =
        matchesPattern(rule.from_pattern, `${senderName} <${senderEmail}>`) ||
        (rule.from_pattern && matchesPattern(rule.from_pattern, body)) ||
        matchesPattern(rule.subject_pattern, subject) ||
        matchesPattern(rule.body_pattern, body);

      // Rule matches if: type-only rule (no patterns) OR patterns match
      if (!hasPatterns || patternMatch) {
        matchedRule = rule;
        break; // first match wins (rules sorted by priority)
      }
    }

    // If matched rule has a custom extract_prompt, re-extract with old method
    let finalContent = content;
    if (matchedRule?.extract_prompt) {
      const customExtraction = await extractEmail(
        senderFull,
        subject,
        body,
        matchedRule.extract_prompt,
      );
      if (customExtraction) finalContent = customExtraction.summary;
    }

    // Step 3: Determine target
    const action = matchedRule?.action || 'forward';
    let targetJid = defaultJid;
    if (
      (matchedRule?.action === 'forward' ||
        matchedRule?.action === 'command') &&
      matchedRule.target_group
    ) {
      const groupEntry = Object.entries(groups).find(
        ([, g]) => g.folder === matchedRule!.target_group,
      );
      if (groupEntry) targetJid = groupEntry[0];
    }

    // Step 4: Log with classification data
    try {
      await logEmail({
        message_id: messageId,
        thread_id: threadId,
        from_address: senderEmail,
        subject,
        rule_id: matchedRule?.id || null,
        rule_name: matchedRule?.name || null,
        action,
        target_group: matchedRule?.target_group || null,
        summary: finalContent?.slice(0, 2000) || null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        processed_at: new Date().toISOString(),
        email_type: emailType,
        structured_data: structuredData,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to log email');
    }

    logger.info(
      { messageId, subject, emailType, hasStructuredData: !!structuredData },
      'Email classified',
    );

    return { targetJid, content: finalContent, action, matchedRule };
  }

  private async markRead(messageId: string): Promise<void> {
    if (!this.gmail) return;
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to mark email as read');
    }
  }

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    // Direct text/plain body
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // Multipart: search parts recursively
    if (payload.parts) {
      // Prefer text/plain
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      // Recurse into nested multipart
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }

    return '';
  }

  private extractHtmlBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    if (payload.mimeType === 'text/html' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      for (const part of payload.parts) {
        const html = this.extractHtmlBody(part);
        if (html) return html;
      }
    }

    return '';
  }
}

// --- Helpers ---

/** Simple case-insensitive contains match. Patterns are comma-separated terms. Leading/trailing * are stripped (wildcard syntax). */
function matchesPattern(pattern: string, text: string): boolean {
  if (!pattern.trim()) return false;
  const lower = text.toLowerCase();
  return pattern
    .split(',')
    .map((t) =>
      t
        .trim()
        .replace(/^\*+|\*+$/g, '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .some((term) => lower.includes(term));
}

/** Strip HTML tags, decode entities, normalize whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Self-register
registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
