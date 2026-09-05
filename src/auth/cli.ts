import { createInterface } from 'node:readline/promises';

import {
    createApiToken, defaultAuthStatePath, listApiTokens, revokeApiToken, setPassword,
} from './state.js';

/** `--name agent-1` / `--name=agent-1`; bare values are returned under "_". */
function parseArguments(argv: readonly string[]): Record<string, string> {
    const parsed: Record<string, string> = {};
    for (let index = 0; index < argv.length; index += 1) {
        const entry = argv[index] ?? '';
        if (!entry.startsWith('--')) { parsed._ = entry; continue; }
        const [flag, inline] = entry.slice(2).split('=');
        if (!flag) continue;
        if (inline !== undefined) { parsed[flag] = inline; continue; }
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) { parsed[flag] = next; index += 1; } else parsed[flag] = 'true';
    }
    return parsed;
}

/** Reads without echoing so the password never lands in the scrollback. */
async function promptHidden(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    const write = output.write.bind(output);
    let muted = false;
    (output as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) =>
        (muted ? true : write(chunk));
    const answer = rl.question(question);
    muted = true;
    try {
        return (await answer).trim();
    } finally {
        muted = false;
        write('\n');
        (output as unknown as { write: typeof write }).write = write;
        rl.close();
    }
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    const args = parseArguments(rest);
    const statePath = args.state ?? defaultAuthStatePath();

    if (command === 'set-password') {
        const password = args.password ?? process.env.PHONE_FARM_PASSWORD ?? await promptHidden('New dashboard password: ');
        if (password.length < 12) throw new Error('Choose a password of at least 12 characters');
        await setPassword(statePath, password);
        console.log(`Password saved to ${statePath}. Set PHONE_FARM_AUTH_PLUGIN=local and restart the web process.`);
        return;
    }

    if (command === 'token-create') {
        const name = args.name;
        if (!name || name === 'true') throw new Error('Usage: npm run token:create -- --name agent-1');
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('Token names may contain letters, numbers, periods, hyphens, and underscores');
        const { token } = await createApiToken(statePath, name);
        console.log(`Token for ${name} (shown once — copy it now):\n\n  ${token}\n`);
        console.log(`Use it as: Authorization: Bearer ${'<token>'}`);
        return;
    }

    if (command === 'token-revoke') {
        const name = args.name ?? args._;
        if (!name || name === 'true') throw new Error('Usage: npm run token:revoke -- --name agent-1');
        const removed = await revokeApiToken(statePath, name);
        console.log(removed.length ? `Revoked ${removed.length} token(s) named ${name}.` : `No token named ${name}.`);
        return;
    }

    if (command === 'token-list') {
        for (const token of await listApiTokens(statePath)) console.log(`${token.name}\t${token.id}\t${token.createdAt}`);
        return;
    }

    throw new Error('Usage: cli.ts <set-password|token-create|token-revoke|token-list> [--name <name>]');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
