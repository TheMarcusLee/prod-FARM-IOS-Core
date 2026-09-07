/**
 * The same question, asked of a model.
 *
 * `recommend.ts` scores words against words, which is fast, predictable and completely literal: a
 * description of a *habit tracker for people getting sober* only reaches the sobriety preset if it
 * happens to use one of that preset's words. A model reads the paragraph instead of matching it,
 * and it can say why in a sentence an operator recognises.
 *
 * It runs through the same `AgentRunner` the calibration job uses — Google's Antigravity CLI on
 * Gemini Flash, no API key, no network client of Backline's own — with three things that keep it
 * cheap and safe:
 *
 * - **the catalogue is in the prompt.** Every preset id, label, category, its one line and its
 *   first six interests. That is the whole world the model may answer from.
 * - **the answer is strict JSON, and it is not trusted.** Ids that are not in the catalogue are
 *   dropped, the lists are capped, the terms go through the persona validator's own rules. A model
 *   that invents `productivity-pro` gets it thrown away rather than stored.
 * - **it falls back.** No CLI, a failed run, unparseable output or nothing recognisable in it, and
 *   the local ranker answers instead. The result says which happened, in `source` and `note`, so
 *   the panel never pretends a ranker answer came from the agent.
 *
 * This is never called from a GET or on page render: it spawns a process and costs a model call,
 * so it is only ever the result of an operator pressing "Ask the agent".
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AGY_FAST_MODEL, createAgyRunner, type AgentRunner } from '../agent/runner.js';
import { isNetwork, NETWORK_IDS, type NetworkId } from '../content/networks.js';
import { PERSONA_PRESETS, findPreset } from './presets.js';
import { normaliseTerms } from './model.js';
import {
    recommendLocally, recommendationText, type RecommendInput, type Recommendation, type RecommendedPreset,
} from './recommend.js';

/** How many presets an answer may name, and how many terms each list may carry. */
export const AGENT_LIMITS = { presets: 8, terms: 8, why: 200, summary: 400 } as const;

export const DEFAULT_RECOMMEND_TIMEOUT_MS = 3 * 60_000;

/**
 * The catalogue, compact. A hundred presets with their full interest lists would be several
 * thousand tokens of prompt for a question worth a few hundred, so each line is the id, the label,
 * the category, the one-liner and the first six interests — enough to tell two neighbouring
 * niches apart, and no more.
 */
export function presetCatalogue(): string {
    return PERSONA_PRESETS.map((preset) => {
        const interests = preset.persona.interests.slice(0, 6).join(', ');
        return `- ${preset.id} | ${preset.label} | ${preset.category} | ${preset.description} | ${interests}`;
    }).join('\n');
}

export interface RecommendPromptInput extends RecommendInput {
    url?: string;
}

export function buildRecommendationPrompt(input: RecommendPromptInput): string {
    return [
        'You are choosing which of a fixed set of social-media personas should promote one product.',
        '',
        'Backline runs a farm of phones. Each account behaves like a person with a niche: what it',
        'watches, what it scrolls past, who it follows. The personas below are the only ones that',
        'exist. Pick the ones whose feed the product belongs in — the audience that would already be',
        'watching this kind of content — not the ones the product is merely about.',
        '',
        '## The product',
        input.name ? `Name: ${input.name}` : '',
        input.url ? `URL: ${input.url}` : '',
        '',
        input.description,
        '',
        input.audience ? `Intended audience: ${input.audience}` : '',
        '',
        '## The persona catalogue',
        'One per line: id | label | category | description | first interests.',
        '',
        presetCatalogue(),
        '',
        '## Answer',
        'Reply with one JSON object and nothing else — no prose before it, no code fence around it:',
        '',
        '{',
        `  "presets": [{"id": "<an id from the catalogue>", "why": "<one short sentence>"}],`,
        '  "extraInterests": ["keyword", "brand name"],',
        '  "avoid": ["keyword"],',
        '  "audienceSummary": "<one sentence about who this is for>",',
        `  "networks": [${NETWORK_IDS.map((network) => `"${network}"`).join(', ')}]`,
        '}',
        '',
        `Rules: at most ${AGENT_LIMITS.presets} presets, best first. Every id must appear in the catalogue`,
        'above, spelled exactly — an id you invent is discarded. `extraInterests` are the words the',
        'chosen presets do not already cover: the brand name, the product noun, the two or three',
        `feature words worth searching for. Between three and ${AGENT_LIMITS.terms} of them, lowercase, a hashtag`,
        'allowed. `avoid` is what these accounts should scroll past. `networks` is which of the four',
        'this product is worth promoting on. Use no tools; this is a reading question.',
    ].filter((line) => line !== undefined).join('\n');
}

/* ---- Reading the answer ------------------------------------------------ */

/**
 * The JSON object in whatever the model said. Models fence their JSON, apologise before it, or add
 * a sentence after it, and none of that is worth failing a run over — so the outermost balanced
 * `{...}` is taken and parsed, and anything else is a miss.
 */
export function extractJson(text: string): unknown {
    const cleaned = text.replace(/```(?:json)?/gi, '');
    const start = cleaned.indexOf('{');
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
        const character = cleaned[index]!;
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '{') depth += 1;
        if (character === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(cleaned.slice(start, index + 1));
                } catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}

function termList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const usable = value.filter((entry): entry is string => typeof entry === 'string');
    const terms: string[] = [];
    for (const entry of usable) {
        // One at a time: a model that returns "AI tools!" should cost that one term, not the list.
        try {
            for (const term of normaliseTerms([entry], 'interest')) {
                if (!terms.includes(term)) terms.push(term);
            }
        } catch { /* dropped */ }
        if (terms.length >= AGENT_LIMITS.terms) break;
    }
    return terms.slice(0, AGENT_LIMITS.terms);
}

export interface ParsedRecommendation {
    presets: RecommendedPreset[];
    extraInterests: string[];
    avoid: string[];
    audienceSummary?: string;
    networks: NetworkId[];
}

/**
 * What survives of a model's answer. Unknown ids are dropped rather than reported: the catalogue is
 * the authority, and a shortlist of four good ids with one invented one is still a good shortlist.
 * Returns undefined when nothing recognisable is left, which is what makes the caller fall back.
 */
export function parseAgentRecommendation(value: unknown): ParsedRecommendation | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const presets: RecommendedPreset[] = [];
    for (const entry of Array.isArray(input.presets) ? input.presets : []) {
        const row = typeof entry === 'string' ? { id: entry } : entry;
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const { id, why } = row as Record<string, unknown>;
        const preset = findPreset(id);
        if (!preset || presets.some((chosen) => chosen.id === preset.id)) continue;
        presets.push({
            id: preset.id, label: preset.label, category: preset.category,
            why: typeof why === 'string' && why.trim()
                ? why.trim().slice(0, AGENT_LIMITS.why)
                : preset.description,
        });
        if (presets.length >= AGENT_LIMITS.presets) break;
    }
    if (!presets.length) return undefined;
    const summary = typeof input.audienceSummary === 'string'
        ? input.audienceSummary.trim().slice(0, AGENT_LIMITS.summary)
        : '';
    return {
        presets,
        extraInterests: termList(input.extraInterests),
        avoid: termList(input.avoid),
        ...(summary ? { audienceSummary: summary } : {}),
        networks: [...new Set((Array.isArray(input.networks) ? input.networks : []).filter(isNetwork))] as NetworkId[],
    };
}

/* ---- Running it -------------------------------------------------------- */

export interface AgentRecommendOptions {
    /** Injected in tests; defaults to the Antigravity CLI, exactly as the calibrate job does. */
    runner?: AgentRunner;
    /** Antigravity model slug. Flash by default — this is one short reading question. */
    model?: string;
    timeoutMs?: number;
    /** A directory the agent may read. A throwaway one is made and removed when this is absent. */
    workspaceDirectory?: string;
    signal?: AbortSignal;
    log?(line: string): void;
}

/** Whether "Ask the agent" can be offered at all — the calibrate job's own check. */
export async function agentUnavailable(runner: AgentRunner = createAgyRunner()): Promise<string | undefined> {
    return runner.unavailable();
}

/**
 * Ask the agent, and answer with the ranker when it cannot be asked or does not answer usefully.
 * Never throws: a recommendation an operator pressed a button for always comes back as a
 * recommendation, with `source` saying which half produced it and `note` saying why.
 */
export async function recommendWithAgent(
    input: RecommendPromptInput, options: AgentRecommendOptions = {},
): Promise<Recommendation> {
    const runner = options.runner ?? createAgyRunner();
    const fallback = (note: string): Recommendation => ({ ...recommendLocally(input), note });

    const missing = await runner.unavailable().catch((error: unknown) =>
        error instanceof Error ? error.message : String(error));
    if (missing) return fallback(`${missing} Ranked locally instead.`);

    const prompt = buildRecommendationPrompt(input);
    let workspace = options.workspaceDirectory;
    let temporary: string | undefined;
    if (!workspace) {
        temporary = await mkdtemp(path.join(tmpdir(), 'backline-recommend-'));
        workspace = temporary;
    }
    try {
        const result = await runner.run({
            prompt,
            model: options.model ?? AGY_FAST_MODEL,
            cwd: workspace,
            timeoutMs: options.timeoutMs ?? DEFAULT_RECOMMEND_TIMEOUT_MS,
            // A reading question: the agent is given no tools at all, not even this farm's own.
            mcpServers: [],
            ...(options.signal ? { signal: options.signal } : {}),
        }, (line) => options.log?.(line));

        if (!result.ok) return fallback(`The agent run failed: ${result.error ?? result.status}. Ranked locally instead.`);
        const parsed = parseAgentRecommendation(extractJson(result.lastMessage ?? ''));
        if (!parsed) return fallback('The agent did not answer with anything usable. Ranked locally instead.');

        // The words it added are the ones worth keeping; if it named none, the local pass fills
        // them in, since that part is arithmetic rather than judgement.
        const extras = parsed.extraInterests.length
            ? parsed.extraInterests
            : recommendLocally(input).extraInterests;
        return {
            source: 'agent',
            presets: parsed.presets,
            extraInterests: extras,
            avoid: parsed.avoid,
            ...(parsed.audienceSummary ? { audienceSummary: parsed.audienceSummary } : {}),
            networks: parsed.networks,
            createdAt: new Date().toISOString(),
        };
    } catch (error) {
        return fallback(`The agent could not be run: ${error instanceof Error ? error.message : String(error)}. Ranked locally instead.`);
    } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Exported for the prompt test: the text both halves score against. */
export { recommendationText };
