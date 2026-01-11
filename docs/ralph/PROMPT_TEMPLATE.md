# PROMPT.md Template for MCP Server Development

> **Instructions for Claude Code** - This file tells Claude how to work on this MCP server project

---

## Project Context

You are building **[PROJECT_NAME] MCP Server**, a Model Context Protocol server that enables Claude to interact with the [API_NAME] API for workforce management tasks.

**Repository Pattern:** This project follows the architecture established in `Tanda-Workforce-MCP-Server` v3.0.

---

## Development Guidelines

### File Structure

```
src/
  ├── auth/           # OAuth2 implementation
  │   ├── oauth.ts    # Authorization flow
  │   └── middleware.ts
  ├── config/
  │   └── environment.ts  # Zod-validated env config
  ├── mcp/
  │   ├── handler.ts  # JSON-RPC request handler
  │   └── tools.ts    # Tool definitions array
  ├── [service]/
  │   ├── client.ts   # API client class
  │   └── types.ts    # TypeScript interfaces
  ├── server/
  │   └── app.ts      # Express setup
  ├── utils/
  │   └── logger.ts   # Winston configuration
  └── index.ts        # Entry point
```

### Code Patterns to Follow

#### 1. Tool Definition Pattern
```typescript
// In src/mcp/tools.ts
export const MCP_TOOLS: MCPTool[] = [
  {
    name: '[service]_[action]_[resource]',
    description: 'Clear description of what this tool does. Include return value info.',
    inputSchema: {
      type: 'object',
      properties: {
        param_name: {
          type: 'string',
          description: 'What this parameter is for'
        }
      },
      required: ['param_name']
    }
  }
];
```

#### 2. API Client Pattern
```typescript
// In src/[service]/client.ts
export class ServiceClient {
  private axiosInstance: AxiosInstance;

  constructor(accessToken: string) {
    this.axiosInstance = axios.create({
      baseURL: 'https://api.[service].com/v1',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  }

  async getResource(id: string): Promise<Resource> {
    const response = await this.axiosInstance.get(`/resources/${id}`);
    return response.data;
  }
}
```

#### 3. Tool Execution Pattern
```typescript
// In src/mcp/tools.ts executeTool function
case '[service]_get_[resource]': {
  const { resource_id } = args as { resource_id: string };
  const client = new ServiceClient(accessToken);
  const result = await client.getResource(resource_id);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
}
```

#### 4. Environment Config Pattern
```typescript
// In src/config/environment.ts
const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  [SERVICE]_CLIENT_ID: z.string().min(1, 'Required'),
  [SERVICE]_CLIENT_SECRET: z.string().min(1, 'Required'),
  SESSION_SECRET: z.string().min(32, 'Must be at least 32 characters'),
});
```

---

## Task Execution Rules

### DO:
- Read existing code before modifying
- Follow the established patterns exactly
- Run tests after implementing features: `npm test`
- Update types when adding new API responses
- Add tools to both `MCP_TOOLS` array and `executeTool` switch
- Use Zod for input validation where appropriate
- Log errors with Winston logger
- Mark tasks complete in `@fix_plan.md` when done

### DON'T:
- Create new architectural patterns
- Add dependencies without necessity
- Skip error handling
- Leave console.log statements
- Modify package.json scripts without reason
- Change the MCP protocol version

---

## Progress Tracking

After completing each task:

1. **Update `@fix_plan.md`** - Mark the task as `[x]`
2. **Git commit** with descriptive message:
   ```
   feat: implement [service]_get_[resource] tool
   fix: resolve OAuth token refresh issue
   docs: update README with new tools
   ```
3. **Run validation**:
   ```bash
   npm run build
   npm test
   ```

---

## Exit Conditions

Signal completion when:
- All `[ ]` tasks in `@fix_plan.md` are `[x]`
- `npm run build` succeeds with no errors
- `npm test` passes all tests
- No TypeScript errors in `src/`

---

## Current Task

Check `@fix_plan.md` for the next uncompleted `[ ]` task. Work on tasks in priority order:
1. P0 (Critical) - Must complete
2. P1 (High) - Should complete
3. P2 (Medium) - Nice to have

---

## Reference Files

When implementing, reference these patterns:
- `src/mcp/tools.ts` - Tool definitions
- `src/mcp/handler.ts` - MCP protocol handling
- `src/tanda/client.ts` - API client implementation
- `src/config/environment.ts` - Environment validation

---

*This PROMPT.md is designed for Ralph Claude Code autonomous workflow*
