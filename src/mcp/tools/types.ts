import { TandaClient } from '../../tanda/client';
import { Args } from '../args';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface Tool extends ToolDefinition {
  run(client: TandaClient, args: Args): Promise<unknown>;
}
