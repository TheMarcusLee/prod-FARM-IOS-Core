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

interface McpSession {
    transport: StreamableHTTPServerTransport;
    /** The API token that opened this session; no other token may use it. */
    tokenId: string;
    lastSeen: number;
}

/** A session with no traffic for this long is abandoned, whatever the client said. */
export const SESSION_IDLE_MS = 30 * 60_000;
export const MAX_SESSIONS = 64;

/**
 * Agents send no Origin at all. A browser always does, so an Origin that is
 * present and untrusted is the DNS-rebinding / cross-site case, and is refused
 * — the same trusted-origin configuration the dashboard's CSRF guard reads.
 */
export function originAllowed(origin: string | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
    if (!origin) return true;
    const configured = [environment.PUBLIC_ORIGIN, ...(environment.PHONE_FARM_TRUSTED_ORIGINS ?? '').split(',')]
        .map((value) => value?.trim().replace(/\/+$/, ''))
        .filter((value): value is string => Boolean(value));
    return configured.includes(origin.trim().replace(/\/+$/, ''));
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
    const sessions = new Map<string, McpSession>();

    /**
     * A session that is never closed cleanly — an agent that is killed, a
     * tunnel that drops — leaves its transport (and the MCP server behind it)
     * alive for the life of the process. Sweep the idle ones, and cap how many
     * can exist at once so a loop of `initialize` calls cannot exhaust memory.
     */
    const sweep = (now = Date.now()): void => {
        for (const [id, session] of sessions) {
            if (now - session.lastSeen > SESSION_IDLE_MS) {
                sessions.delete(id);
                void session.transport.close().catch(() => undefined);
            }
        }
    };

    const openSession = async (tokenId: string): Promise<StreamableHTTPServerTransport> => {
        sweep();
        if (sessions.size >= MAX_SESSIONS) throw Object.assign(new Error('Too many open MCP sessions'), { statusCode: 503 });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sessionId) => {
                sessions.set(sessionId, { transport, tokenId, lastSeen: Date.now() });
            },
        });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        await createFarmMcpServer(dependencies).connect(transport);
        return transport;
    };

    const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
        // An MCP client is an agent, not a page. A browser that has been
        // pointed at a rebound DNS name still cannot set Authorization, but if
        // one ever reaches here it arrives carrying an Origin, and an Origin
        // this farm does not trust is not something to serve tools to.
        if (!originAllowed(request.headers.origin)) {
            return reply.code(403).send({ error: 'Cross-origin MCP requests are not accepted' });
        }
        const token = await tokenForAuthorization(statePath, request.headers.authorization);
        if (!token) {
            return reply.code(401).header('www-authenticate', 'Bearer realm="backline"')
                .send({ error: 'A Backline API token is required. Create one with `npm run token:create`.' });
        }
        const sessionId = request.headers['mcp-session-id'];
        const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        // A session belongs to the token that opened it. Every token has the
        // same rights today, but a revoked phone's token must not be able to
        // keep talking through a session the desktop app opened.
        if (session && session.tokenId !== token.id) {
            return reply.code(404).send({ error: 'No such MCP session' });
        }
        if (!session && !(request.method === 'POST' && isInitializeRequest(request.body))) {
            return reply.code(400).send({ error: 'No MCP session — send an initialize request first' });
        }
        if (session) session.lastSeen = Date.now();
        const transport = session?.transport ?? await openSession(token.id);
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

    const idleSweep = setInterval(() => sweep(), SESSION_IDLE_MS);
    idleSweep.unref?.();

    app.addHook('onClose', async () => {
        clearInterval(idleSweep);
        for (const session of [...sessions.values()]) await session.transport.close();
        sessions.clear();
    });
}
