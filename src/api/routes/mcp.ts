import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { defaultAuthStatePath, tokenForAuthorization } from '../../auth/state.js';
import { createFarmDependencies, type FarmDependencyOptions } from '../../mcp/dependencies.js';
import { createFarmMcpServer } from '../../mcp/server.js';
import type { McpDependencies } from '../../mcp/types.js';

export interface McpRouteOptions extends Partial<FarmDependencyOptions> {
    /** Supply this instead of scheduler/plugins/screenshot to drive the tools from a fake. */
    dependencies?: McpDependencies;
    /** Where the API tokens live. Defaults to AUTH_STATE_PATH / `.auth.json`. */
    statePath?: string;
    /** Mount point. Defaults to /mcp. */
    path?: string;
}

function resolveDependencies(options: McpRouteOptions): McpDependencies {
    if (options.dependencies) return options.dependencies;
    if (!options.scheduler || !options.plugins || !options.screenshot) {
        throw new Error('registerMcpRoutes needs either dependencies or scheduler + plugins + screenshot');
    }
    return createFarmDependencies({
        scheduler: options.scheduler, plugins: options.plugins, screenshot: options.screenshot,
    });
}

/**
 * Mounts the MCP Streamable HTTP transport. Always token-protected on its own —
 * `/mcp` is an agent endpoint, never a browser one, so it does not inherit the
 * dashboard's cookie session even when no auth provider is configured.
 */
export async function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions): Promise<void> {
    const dependencies = resolveDependencies(options);
    const statePath = options.statePath ?? defaultAuthStatePath();
    const mountPath = options.path ?? '/mcp';
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const openSession = async (): Promise<StreamableHTTPServerTransport> => {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sessionId) => { transports.set(sessionId, transport); },
        });
        transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
        await createFarmMcpServer(dependencies).connect(transport);
        return transport;
    };

    const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
        const token = await tokenForAuthorization(statePath, request.headers.authorization);
        if (!token) {
            return reply.code(401).header('www-authenticate', 'Bearer realm="phone-farm"')
                .send({ error: 'A phone farm API token is required. Create one with `npm run token:create`.' });
        }
        const sessionId = request.headers['mcp-session-id'];
        const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
        if (!existing && !(request.method === 'POST' && isInitializeRequest(request.body))) {
            return reply.code(400).send({ error: 'No MCP session — send an initialize request first' });
        }
        const transport = existing ?? await openSession();
        if (request.method !== 'GET') {
            request.log.info({ apiToken: token.name, sessionId: transport.sessionId }, 'MCP request');
        }
        // The transport owns the response from here; Fastify must not also reply.
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
        return reply;
    };

    app.post(mountPath, handle);
    app.get(mountPath, handle);
    app.delete(mountPath, handle);

    app.addHook('onClose', async () => {
        for (const transport of [...transports.values()]) await transport.close();
        transports.clear();
    });
}
