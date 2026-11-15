import { TandaClient } from '../../tanda/client';
import { Args } from '../args';
import { AppView } from '../apps/ui';

export interface ToolDefinition {
  name: string;
  /** Human-readable name shown by hosts. */
  title?: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
  /** MCP Apps: `ui.resourceUri` names the ui:// resource a host renders for this tool. */
  _meta?: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  run(client: TandaClient, args: Args): Promise<unknown>;
  /**
   * Set on MCP App tools: the view that renders the result, and the plain-text summary a
   * model (or a host without MCP Apps) reads. The result itself goes out as structuredContent.
   */
  app?: { view: AppView; summary(content: Record<string, unknown>): string };
}
