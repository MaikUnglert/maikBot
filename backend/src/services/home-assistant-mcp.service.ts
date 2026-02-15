import { config } from '../config.js';

interface ToolResult {
  ok: boolean;
  output: string;
}

export class HomeAssistantMcpService {
  isConfigured(): boolean {
    return Boolean(config.haMcpBaseUrl && config.haMcpApiKey);
  }

  async runTool(userInstruction: string): Promise<ToolResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        output:
          'Home Assistant MCP is not configured yet. Set HA_MCP_BASE_URL and HA_MCP_API_KEY.',
      };
    }

    const response = await fetch(`${config.haMcpBaseUrl}/tool/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.haMcpApiKey}`,
      },
      body: JSON.stringify({
        tool: config.haMcpToolName,
        input: userInstruction,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        output: `MCP tool call failed (${response.status}): ${body}`,
      };
    }

    const data = (await response.json()) as { output?: string };

    return {
      ok: true,
      output: data.output ?? 'MCP tool executed successfully.',
    };
  }
}

export const homeAssistantMcpService = new HomeAssistantMcpService();
