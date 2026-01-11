# QuickBooks MCP Server - Product Requirements Document

> **Ralph Workflow Compatible** - Ready for autonomous deployment via `ralph-import`

## Overview

| Field | Value |
|-------|-------|
| **Project** | QuickBooks MCP Server |
| **Version** | 1.0.0 |
| **Target API** | QuickBooks Online API v3 |
| **OAuth Scopes** | `com.intuit.quickbooks.accounting` |
| **Estimated Tools** | 24 tools |
| **Priority** | P0 (Critical) |

### Problem Statement

Businesses need Claude to help manage their QuickBooks accounting data - creating invoices, tracking expenses, managing customers, and generating financial reports. This MCP server enables Claude to interact with QuickBooks Online, making accounting tasks conversational and efficient.

### Success Criteria

- [ ] All P0 tools implemented and tested (12 tools)
- [ ] OAuth2 authentication working with Intuit Developer
- [ ] Deployed to Railway with auto-scaling
- [ ] Claude can create invoices, manage customers, and query transactions

---

## Technical Requirements

### Stack

```
Runtime:     Node.js 18+
Language:    TypeScript 5.3+
Framework:   Express 4.18+
Auth:        OAuth2 with PKCE (Intuit requires PKCE)
Validation:  Zod
Logging:     Winston
Testing:     Jest
Deployment:  Docker / Railway
```

### API Integration

| Requirement | Details |
|-------------|---------|
| Base URL | `https://quickbooks.api.intuit.com/v3/company/{realmId}` |
| Auth Type | OAuth2 with PKCE |
| Rate Limits | 500 requests/minute |
| Scopes Required | `com.intuit.quickbooks.accounting`, `openid`, `profile`, `email` |

### OAuth Endpoints (Intuit)

| Endpoint | URL |
|----------|-----|
| Authorization | `https://appcenter.intuit.com/connect/oauth2` |
| Token | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
| Revoke | `https://developer.api.intuit.com/v2/oauth2/tokens/revoke` |
| UserInfo | `https://accounts.platform.intuit.com/v1/openid_connect/userinfo` |

---

## Feature Specification

### Phase 1: Core Infrastructure (P0)

#### F1.1 - OAuth2 Authentication with PKCE
```
Priority: P0
Complexity: High
Dependencies: None
```

**Requirements:**
- [ ] OAuth2 authorization flow with PKCE (code_verifier/code_challenge)
- [ ] Store realmId (company ID) with tokens
- [ ] Token refresh with 1-hour access / 100-day refresh tokens
- [ ] Multi-company support (switch between connected companies)

**Acceptance Criteria:**
- User connects QuickBooks company via OAuth
- realmId captured and stored per session
- Token refresh works before expiry

---

#### F1.2 - MCP Protocol Handler
```
Priority: P0
Complexity: Medium
Dependencies: F1.1
```

**Requirements:**
- [ ] JSON-RPC 2.0 handler with SSE transport
- [ ] Handle realmId context for all API calls
- [ ] Read-only mode support
- [ ] Proper error mapping from QuickBooks errors

**Acceptance Criteria:**
- Claude Desktop connects successfully
- Company context persists across tool calls
- Errors return meaningful messages

---

### Phase 2: Tool Categories

> **Naming Convention:** `qbo_[action]_[resource]`

#### Category: Customer Management (6 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `qbo_get_customer` | Get customer by ID | P0 | No |
| `qbo_list_customers` | List customers with filters | P0 | No |
| `qbo_search_customers` | Search by name/email | P0 | No |
| `qbo_create_customer` | Create new customer | P1 | Yes |
| `qbo_update_customer` | Update customer details | P1 | Yes |
| `qbo_delete_customer` | Deactivate customer | P2 | Yes |

**Tool Schema - qbo_get_customer:**
```typescript
{
  name: 'qbo_get_customer',
  description: 'Get QuickBooks customer by ID. Returns display name, email, phone, billing address, balance, and notes.',
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: {
        type: 'string',
        description: 'The QuickBooks customer ID'
      }
    },
    required: ['customer_id']
  }
}
```

---

#### Category: Invoice Management (6 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `qbo_get_invoice` | Get invoice by ID | P0 | No |
| `qbo_list_invoices` | List invoices with date/status filters | P0 | No |
| `qbo_create_invoice` | Create invoice for customer | P0 | Yes |
| `qbo_send_invoice` | Email invoice to customer | P1 | Yes |
| `qbo_void_invoice` | Void an invoice | P2 | Yes |
| `qbo_get_invoice_pdf` | Download invoice as PDF | P2 | No |

**Tool Schema - qbo_create_invoice:**
```typescript
{
  name: 'qbo_create_invoice',
  description: 'Create a new invoice in QuickBooks. Requires customer ID and line items.',
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: {
        type: 'string',
        description: 'The customer to invoice'
      },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
            quantity: { type: 'number', default: 1 }
          }
        },
        description: 'Line items for the invoice'
      },
      due_date: {
        type: 'string',
        description: 'Due date in YYYY-MM-DD format'
      },
      memo: {
        type: 'string',
        description: 'Internal memo for the invoice'
      }
    },
    required: ['customer_id', 'line_items']
  }
}
```

---

#### Category: Expense & Vendor Management (6 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `qbo_get_vendor` | Get vendor by ID | P1 | No |
| `qbo_list_vendors` | List all vendors | P1 | No |
| `qbo_list_expenses` | List purchases/expenses | P0 | No |
| `qbo_create_expense` | Record an expense | P1 | Yes |
| `qbo_list_bills` | List unpaid bills | P1 | No |
| `qbo_create_bill` | Create vendor bill | P2 | Yes |

---

#### Category: Reports & Queries (6 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `qbo_profit_loss` | Profit & Loss report | P0 | No |
| `qbo_balance_sheet` | Balance Sheet report | P0 | No |
| `qbo_accounts_receivable` | A/R aging summary | P1 | No |
| `qbo_accounts_payable` | A/P aging summary | P1 | No |
| `qbo_query` | Custom SQL-like query | P1 | No |
| `qbo_get_company_info` | Company preferences/info | P0 | No |

**Tool Schema - qbo_profit_loss:**
```typescript
{
  name: 'qbo_profit_loss',
  description: 'Generate Profit & Loss report. Returns income, expenses, and net profit for date range.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date YYYY-MM-DD (default: first of current month)'
      },
      end_date: {
        type: 'string',
        description: 'End date YYYY-MM-DD (default: today)'
      },
      accounting_method: {
        type: 'string',
        enum: ['Cash', 'Accrual'],
        description: 'Accounting method (default: company preference)'
      }
    },
    required: []
  }
}
```

---

## API Coverage Matrix

### OAuth Scopes → Capabilities

| Scope | Description | Tools Enabled |
|-------|-------------|---------------|
| `com.intuit.quickbooks.accounting` | Full accounting access | All 24 tools |
| `openid` | User identity | Auth context |
| `profile` | User profile | User info display |
| `email` | User email | Notifications |

### Fit-Gap Analysis

| QuickBooks Entity | Status | Tools | Priority |
|-------------------|--------|-------|----------|
| Customer | Full | 6 | P0/P1 |
| Invoice | Full | 6 | P0/P1 |
| Vendor | Partial | 2 | P1 |
| Expense/Purchase | Partial | 2 | P1 |
| Bill | Partial | 2 | P2 |
| Reports | Full | 4 | P0/P1 |
| Payment | Gap | - | P2 |
| Estimate | Gap | - | P2 |

---

## Deployment Requirements

### Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# QuickBooks OAuth (from developer.intuit.com)
QBO_CLIENT_ID=your_client_id
QBO_CLIENT_SECRET=your_client_secret
QBO_REDIRECT_URI=https://your-domain.com/auth/callback
QBO_ENVIRONMENT=production  # or 'sandbox'

# Security
SESSION_SECRET=your_session_secret_min_32_chars
JWT_SECRET=your_jwt_secret_min_32_chars

# Optional
MCP_READ_ONLY_MODE=false
LOG_LEVEL=info
```

### Railway Configuration

```bash
# Auto-detected
RAILWAY_PUBLIC_DOMAIN  # For OAuth redirect
RAILWAY_ENVIRONMENT    # Sets NODE_ENV

# Required secrets (set in Railway dashboard)
QBO_CLIENT_ID
QBO_CLIENT_SECRET
SESSION_SECRET
JWT_SECRET
```

---

## Test Scenarios

### Workflow 1: Invoice Customer

```markdown
**Scenario:** User asks Claude to invoice a customer for services

**Steps:**
1. Claude calls `qbo_search_customers` with name query
2. Claude calls `qbo_create_invoice` with customer_id and line items
3. Claude calls `qbo_send_invoice` to email the invoice

**Expected Result:** Invoice created and sent, returns invoice number and total

**Validation:** Check QuickBooks dashboard for new invoice
```

### Workflow 2: Monthly Financial Review

```markdown
**Scenario:** User asks for financial summary

**Steps:**
1. Claude calls `qbo_profit_loss` for current month
2. Claude calls `qbo_accounts_receivable` for outstanding invoices
3. Claude calls `qbo_accounts_payable` for unpaid bills
4. Claude summarizes financial position

**Expected Result:** Complete financial overview with actionable insights

**Validation:** Compare with QuickBooks reports
```

### Workflow 3: Record Expense

```markdown
**Scenario:** User tells Claude about a business expense

**Steps:**
1. Claude calls `qbo_list_vendors` to find or suggest vendor
2. Claude calls `qbo_create_expense` with details
3. Claude confirms expense recorded

**Expected Result:** Expense recorded in QuickBooks

**Validation:** Check expenses in QuickBooks
```

---

## Task Breakdown for @fix_plan.md

### Infrastructure Tasks

```
- [ ] [P0] Initialize TypeScript project with Express
- [ ] [P0] Configure Zod environment validation with QBO variables
- [ ] [P0] Implement OAuth2 flow with PKCE for Intuit
- [ ] [P0] Store realmId with session tokens
- [ ] [P0] Create MCP JSON-RPC handler with SSE
- [ ] [P0] Set up Winston logging
- [ ] [P1] Add rate limiting (500/min)
- [ ] [P1] Configure Helmet security headers
- [ ] [P1] Add token refresh interceptor
```

### API Client Tasks

```
- [ ] [P0] Create QuickBooksClient class with axios
- [ ] [P0] Add request interceptor for realmId injection
- [ ] [P0] Add error handling for QBO error codes
- [ ] [P1] Implement query builder for SQL-like queries
```

### Tool Implementation Tasks - P0

```
- [ ] [P0] Implement qbo_get_company_info tool
- [ ] [P0] Implement qbo_get_customer tool
- [ ] [P0] Implement qbo_list_customers tool
- [ ] [P0] Implement qbo_search_customers tool
- [ ] [P0] Implement qbo_get_invoice tool
- [ ] [P0] Implement qbo_list_invoices tool
- [ ] [P0] Implement qbo_create_invoice tool
- [ ] [P0] Implement qbo_list_expenses tool
- [ ] [P0] Implement qbo_profit_loss tool
- [ ] [P0] Implement qbo_balance_sheet tool
```

### Tool Implementation Tasks - P1

```
- [ ] [P1] Implement qbo_create_customer tool
- [ ] [P1] Implement qbo_update_customer tool
- [ ] [P1] Implement qbo_send_invoice tool
- [ ] [P1] Implement qbo_get_vendor tool
- [ ] [P1] Implement qbo_list_vendors tool
- [ ] [P1] Implement qbo_create_expense tool
- [ ] [P1] Implement qbo_list_bills tool
- [ ] [P1] Implement qbo_accounts_receivable tool
- [ ] [P1] Implement qbo_accounts_payable tool
- [ ] [P1] Implement qbo_query tool
```

### Tool Implementation Tasks - P2

```
- [ ] [P2] Implement qbo_delete_customer tool
- [ ] [P2] Implement qbo_void_invoice tool
- [ ] [P2] Implement qbo_get_invoice_pdf tool
- [ ] [P2] Implement qbo_create_bill tool
```

### Testing Tasks

```
- [ ] [P1] Write unit tests for QuickBooksClient
- [ ] [P1] Write integration tests for OAuth flow
- [ ] [P1] Create tool execution test suite
- [ ] [P1] Test with QuickBooks sandbox company
- [ ] [P2] Add end-to-end workflow tests
```

### Documentation Tasks

```
- [ ] [P1] Write README with OAuth setup guide
- [ ] [P1] Document all environment variables
- [ ] [P1] Add Intuit Developer portal setup instructions
- [ ] [P2] Create Railway deployment guide
- [ ] [P2] Add FIT_GAP_ANALYSIS.md
```

---

## QuickBooks API Reference

### Common Entities

```typescript
interface QBOCustomer {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  BillAddr?: QBOAddress;
  Balance: number;
  Active: boolean;
}

interface QBOInvoice {
  Id: string;
  DocNumber: string;
  CustomerRef: { value: string; name: string };
  TxnDate: string;
  DueDate: string;
  TotalAmt: number;
  Balance: number;
  Line: QBOLine[];
}

interface QBOLine {
  Amount: number;
  Description?: string;
  DetailType: 'SalesItemLineDetail' | 'SubTotalLineDetail';
  SalesItemLineDetail?: {
    ItemRef: { value: string; name: string };
    Qty: number;
    UnitPrice: number;
  };
}
```

### Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Invalid/expired token | Refresh token |
| 403 | Missing scope | Check OAuth scopes |
| 429 | Rate limited | Retry with backoff |
| 500 | QBO server error | Retry later |
| 6000+ | QBO validation errors | Check request format |

---

## Appendix

### Intuit Developer Setup

1. Create app at https://developer.intuit.com
2. Select "QuickBooks Online and Payments"
3. Configure OAuth 2.0 with PKCE
4. Add redirect URI for your deployment
5. Request production credentials when ready

### Sandbox Testing

```bash
# Use sandbox environment
QBO_ENVIRONMENT=sandbox

# Sandbox company auto-created at developer.intuit.com
# Test data includes sample customers, invoices, etc.
```

---

*Generated for Ralph Claude Code workflow - PRD template v1.0*
