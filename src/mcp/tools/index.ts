import { TandaClient, TandaApiError } from '../../tanda/client';
import { logger } from '../../utils/logger';
import { ArgError, Args } from '../args';
import { guardResponse, byteSize, MAX_BYTES } from '../guard';
import { parseFields, redactSensitive } from '../privacy';
import { Tool, ToolDefinition } from './types';
import { orgTool } from './org';
import { peopleTool } from './people';
import { schedulesTool } from './schedules';
import { timesheetsTool } from './timesheets';
import { liveTool } from './live';
import { timeOffTool } from './timeOff';
import { laborSummaryTool } from './labor';
import { coverageTool } from './coverage';
import { validateScheduleTool } from './validate';
import { exceptionsTool } from './exceptions';
import { exportPreviewTool } from './exportPreview';
import { changeHistoryTool } from './changeHistory';
import { dataAuditTool } from './dataAudit';
import { payPeriodsTool } from './payPeriods';
import { ALIAS_NAMES, resolveAlias, V3_ALIASES } from './aliases';

export type MCPTool = ToolDefinition;
export { aliasUsage } from './aliases';

export const TOOLS: Tool[] = [
  orgTool,
  peopleTool,
  schedulesTool,
  timesheetsTool,
  liveTool,
  timeOffTool,
  laborSummaryTool,
  coverageTool,
  validateScheduleTool,
  exceptionsTool,
  exportPreviewTool,
  changeHistoryTool,
  dataAuditTool,
  payPeriodsTool,
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** Public tool definitions (no run functions). */
export const tandaTools: MCPTool[] = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/** Deprecated names are callable but not listed, unless MCP_LIST_ALIASES=true. */
export function getAvailableTools(): MCPTool[] {
  if (process.env.MCP_LIST_ALIASES !== 'true') return tandaTools;
  const aliases: MCPTool[] = Object.keys(V3_ALIASES).map((name) => ({
    name,
    description: `Deprecated alias kept for one release; use the v4 tools instead.`,
    inputSchema: { type: 'object', properties: {} },
  }));
  return [...tandaTools, ...aliases];
}

export function isKnownTool(name: string): boolean {
  return byName.has(name) || ALIAS_NAMES.includes(name);
}

/**
 * Final safety net on every tool result: strip sensitive keys (unless requested via
 * `fields`) and make sure nothing over 25 KB leaves the server.
 */
export function finalizeContent(content: unknown, args: Args): unknown {
  const allow = parseFields(args.fields);
  if (args.show_wages === true || args.show_wages === 'true') allow.push('hourly_rate');
  const safe = redactSensitive(content, allow);
  if (byteSize(safe) <= MAX_BYTES) return safe;
  if (Array.isArray(safe)) return guardResponse({ total: safe.length }, safe, { offset: args.offset });
  if (safe && typeof safe === 'object') {
    const obj = safe as Record<string, unknown>;
    if (Array.isArray(obj.rows) && obj.summary) {
      const { rows, summary, page: _page, truncated: _t, how_to_page: _h, ...extra } = obj;
      return guardResponse(summary as Record<string, unknown>, rows as unknown[], { offset: args.offset, extra });
    }
  }
  return guardResponse({ note: 'Result too large; narrow the date range or filters.' }, []);
}

export async function executeTool(
  client: TandaClient,
  toolName: string,
  rawArgs: Args
): Promise<{ content: unknown; isError?: boolean }> {
  let name = toolName;
  let args = rawArgs || {};
  let deprecation: string | undefined;

  const alias = resolveAlias(name, args);
  if (alias) {
    if ('removed' in alias) return { content: { error: alias.removed }, isError: true };
    if (alias.tool !== name) deprecation = `${toolName} is deprecated and will be removed in the next release; use ${alias.tool}.`;
    name = alias.tool;
    args = alias.args;
  }

  const tool = byName.get(name);
  if (!tool) {
    return { content: { error: `Unknown tool: ${toolName}. Available: ${TOOLS.map((t) => t.name).join(', ')}` }, isError: true };
  }

  try {
    let content = await tool.run(client, args);
    if (deprecation && content && typeof content === 'object' && !Array.isArray(content)) {
      content = { deprecation, ...(content as Record<string, unknown>) };
    }
    return { content: finalizeContent(content, args) };
  } catch (error) {
    if (error instanceof ArgError) return { content: { error: error.message, tool: name }, isError: true };
    if (error instanceof TandaApiError) return { content: { ...error.toJSON(), tool: name }, isError: true };
    // Unexpected: log details server-side, return a generic actionable message
    logger.error(`Tool ${name} failed`, { message: error instanceof Error ? error.message : String(error) });
    return { content: { error: `${name} failed unexpectedly. Retry, or narrow the request; if it persists check server logs.`, tool: name }, isError: true };
  }
}
