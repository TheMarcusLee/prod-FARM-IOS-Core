import assert from 'node:assert/strict';
import test from 'node:test';

import { MCP_TOKEN_PLACEHOLDER, mcpConfig } from '../src/main/mcp-config.ts';
import { pausedReason } from '../src/renderer/paused.ts';
import type { FleetSnapshot, ServiceSnapshot, ServiceState } from '../src/main/types.ts';

function service(id: string, state: ServiceState, detail = ''): ServiceSnapshot {
    return {
        id, label: id, state, detail, help: null, optional: false,
        restarts: 0, pid: null, since: null, logPath: null, recentLogs: [],
    };
}

function fleet(services: ServiceSnapshot[], overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
    return { services, jobs: [], dashboardUrl: null, shuttingDown: false, ...overrides };
}

test('a stopped worker is reported as a paused farm, not as one failed row', () => {
    // The state that matters most and was hardest to see: every other service is
    // healthy, the dashboard answers, and not a single schedule will ever run.
    const snapshot = fleet([
        service('web', 'healthy'),
        service('worker', 'failed', 'exited with code 1; gave up after 5 restarts'),
    ]);

    const reason = pausedReason(snapshot);
    assert.match(reason ?? '', /no schedule will run until it is back/);
    assert.match(reason ?? '', /gave up after 5 restarts/, 'the cause travels with the notice');
});

test('a healthy worker means the farm is not paused', () => {
    assert.equal(pausedReason(fleet([service('web', 'healthy'), service('worker', 'healthy')])), null);
});

test('a worker that is still starting says so rather than claiming a failure', () => {
    const reason = pausedReason(fleet([service('worker', 'starting')]));
    assert.match(reason ?? '', /still starting, so nothing is running yet/);
});

test('a fleet on its way down is paused for a reason the operator caused', () => {
    const reason = pausedReason(fleet([service('worker', 'healthy')], { shuttingDown: true }));
    assert.equal(reason, 'The fleet is stopping.');
});

test('the MCP config carries the configured port and a token placeholder, not a real token', () => {
    const parsed = JSON.parse(mcpConfig('http://127.0.0.1:3100')) as {
        mcpServers: { 'phone-farm': { url: string; type: string; headers: Record<string, string> } };
    };
    const server = parsed.mcpServers['phone-farm'];

    assert.equal(server.url, 'http://127.0.0.1:3100/mcp');
    assert.equal(server.type, 'http');
    // /mcp is always token-protected, even on loopback, and the app cannot mint
    // one — so the value itself has to say what to replace it with.
    assert.equal(server.headers.Authorization, `Bearer ${MCP_TOKEN_PLACEHOLDER}`);
    assert.match(MCP_TOKEN_PLACEHOLDER, /PASTE/);
});

test('the MCP url never grows a double slash from a trailing one', () => {
    assert.match(mcpConfig('http://127.0.0.1:3000/'), /"http:\/\/127\.0\.0\.1:3000\/mcp"/);
});
