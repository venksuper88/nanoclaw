# Email Schema Guide

Agents can register custom email types for the email classification engine by creating an `email-schemas.json` file in their group folder.

## How It Works

1. You create `groups/{your_folder}/email-schemas.json`
2. The orchestrator scans all group folders and collates every registered schema
3. When an email arrives, Gemini receives **one combined prompt** with all registered types
4. Gemini classifies the email into the best matching type and extracts the fields you defined
5. The result is stored in `email_log` and routed via email rules in Settings

Schemas are hot-reloaded every 60 seconds — no restart needed.

## File Format

`email-schemas.json` is an array of schema definitions:

```json
[
  {
    "type": "YourTypeName",
    "description": "One-line description for the LLM",
    "classificationPrompt": "When to classify an email as this type",
    "fields": {
      "mandatory": { "fieldName": "description of allowed values" },
      "optional": { "fieldName": "description (NA when not available)" }
    }
  }
]
```

## Writing Good Schemas

**Type name:** PascalCase, specific. `FinancialTransaction` not `Finance`. `SupportTicket` not `Support`.

**Description:** One line. The LLM sees this in a list of all types and picks the best match. Be specific enough to distinguish from other types.

**Classification prompt:** Tell the LLM exactly when to use this type. Be explicit about edge cases. Example: "Classify as FinancialTransaction if the email is about money movement — debits, credits, refunds. Do NOT classify receipts or invoices as this type."

**Fields:**
- Keep mandatory fields to 3-5. These must always have real values.
- Optional fields use `"NA"` when not available (strings), `0` (numbers), `false` (booleans).
- Field descriptions should include allowed values where applicable: `"one of: debit, credit, refund"`.
- Use camelCase for field names.
- Every field adds tokens to the prompt — only include fields you actually need.

## Example: FinancialTransaction

```json
[
  {
    "type": "FinancialTransaction",
    "description": "Bank alerts, UPI payments, credit card transactions, EMI debits, refunds",
    "classificationPrompt": "Classify as FinancialTransaction if the email is about money movement — debits, credits, refunds, reversals, mandates, subscriptions, EMIs, salary credits, or any bank/payment app notification about a financial transaction.",
    "fields": {
      "mandatory": {
        "transactionType": "one of: debit, credit, refund, reversal, emi, mandate, subscription",
        "amount": "numeric amount (0 if truly unknown)",
        "currency": "e.g. INR, USD",
        "transactionDateTime": "ISO 8601 format"
      },
      "optional": {
        "merchant": "payee/merchant name",
        "accountNumber": "masked account/card number",
        "bankName": "bank or financial institution",
        "referenceId": "UTR, reference number, order ID",
        "status": "completed, pending, scheduled, failed",
        "category": "food, travel, subscription, utility, transfer, salary, other"
      }
    }
  }
]
```

## Example: SupportTicket

```json
[
  {
    "type": "SupportTicket",
    "description": "Customer support emails, bug reports, feature requests from users",
    "classificationPrompt": "Classify as SupportTicket if the email is from a user reporting a bug, requesting help, asking about a feature, or following up on a previous support conversation.",
    "fields": {
      "mandatory": {
        "ticketType": "one of: bug, feature_request, question, complaint",
        "product": "product or feature name mentioned",
        "urgency": "one of: low, medium, high, critical"
      },
      "optional": {
        "platform": "iOS, Android, Web, etc.",
        "version": "app or product version if mentioned",
        "steps": "reproduction steps if provided",
        "previousTicketId": "reference to earlier conversation"
      }
    }
  }
]
```

## Rules

- One group can define multiple types in a single file.
- If two groups define the same type name, the first one found wins (scan order is alphabetical by folder name).
- Type `"Other"` is always available as a fallback — don't define it yourself.
- Keep the total prompt concise. The combined prompt from all schemas goes into every email classification call. Verbose prompts waste tokens on every email.
- Test your schema by sending a test email and checking the `email_log` table for `email_type` and `structured_data`.
