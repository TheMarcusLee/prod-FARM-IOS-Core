/**
 * The MCP client configuration for this installation.
 *
 * `/mcp` is mounted by the `web` server and is always token-protected, even on a
 * loopback bind (docs/mcp.md): it is an agent endpoint, never a browser one. The
 * app cannot mint that token — tokens live in the farm's own auth state — so the
 * snippet carries a placeholder that says, in the value itself, what to replace
 * it with. Everything the operator would otherwise have to work out by hand —
 * the transport, the URL, their configured port — is already filled in.
 */
export const MCP_TOKEN_PLACEHOLDER = 'PASTE-YOUR-API-TOKEN-HERE';

export function mcpConfig(dashboardUrl: string): string {
    return `${JSON.stringify({
        mcpServers: {
            'phone-farm': {
                type: 'http',
                url: `${dashboardUrl.replace(/\/+$/, '')}/mcp`,
                headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` },
            },
        },
    }, null, 2)}\n`;
}
