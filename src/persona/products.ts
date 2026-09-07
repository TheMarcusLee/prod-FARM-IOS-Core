/**
 * The things the farm is promoting.
 *
 * A product is a paragraph an operator wrote — what the app is, who it is for, where it lives —
 * plus the last answer Backline gave when asked which presets should be running it. That is the
 * whole model. It is stored the way personas are: one JSON document under
 * `SCHEDULER_DATA_DIR/products.json`, written temp-file-then-rename, readable and diffable by
 * hand. No table and no migration, because a handful of products is not a database problem.
 *
 * Everything a browser can set goes through `validateProduct`, which is a whitelist like
 * `validatePersona`: unknown keys are dropped rather than stored, and the free text is capped
 * before it can reach the store.
 */

import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { blendPresets } from './blend.js';
import {
    LIMITS, PersonaError, normaliseHandle, normaliseTerms, validatePersona, type Persona,
} from './model.js';
import { isNetwork, type NetworkId } from '../content/networks.js';
import type { RecommendedPreset, Recommendation } from './recommend.js';

export class ProductError extends Error {}

export interface Product {
    id: string;
    name: string;
    /** Free text: what it is, what it does, who it is for. The ranker's whole input. */
    description: string;
    url?: string;
    /** Free text: who should see it. Scored alongside the description. */
    audience?: string;
    createdAt: string;
    /** The last recommendation asked for, whichever half produced it. */
    recommendation?: Recommendation;
}

export const PRODUCT_LIMITS = {
    name: 80,
    description: 2000,
    url: 500,
    audience: 500,
    /** Presets one recommendation may name. The same ceiling a persona blend has. */
    presets: LIMITS.presets,
    terms: 12,
} as const;

/* ---- Validation -------------------------------------------------------- */

function object(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductError(`${name} must be an object`);
    return value as Record<string, unknown>;
}

function trimmed(value: unknown, name: string, limit: number, required: boolean): string | undefined {
    if (value === undefined || value === null || value === '') {
        if (required) throw new ProductError(`${name} is required`);
        return undefined;
    }
    if (typeof value !== 'string') throw new ProductError(`${name} must be text`);
    const text = value.trim().replace(/\r\n/g, '\n');
    if (!text) {
        if (required) throw new ProductError(`${name} is required`);
        return undefined;
    }
    if (text.length > limit) throw new ProductError(`${name} may be at most ${limit} characters`);
    return text;
}

/** Only http(s). The URL is printed in the panel and opened by an operator, never fetched. */
function productUrl(value: unknown): string | undefined {
    const text = trimmed(value, 'URL', PRODUCT_LIMITS.url, false);
    if (!text) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(text);
    } catch {
        throw new ProductError('URL must be a full address, e.g. https://example.com');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ProductError('URL must be http or https');
    }
    return parsed.toString();
}

export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function normaliseProductId(value: unknown): string {
    if (typeof value !== 'string' || !PRODUCT_ID_PATTERN.test(value.trim())) {
        throw new ProductError('That is not a product id');
    }
    return value.trim();
}

/**
 * A stored recommendation, read back defensively. This is the one part of a product that was not
 * typed by the operator — it came from a ranker or from a model — so it is re-checked on the way
 * in and on the way out, and an entry that has gone bad is dropped rather than failing the file.
 */
export function validateRecommendation(value: unknown): Recommendation | undefined {
    if (value === undefined || value === null) return undefined;
    const input = object(value, 'Recommendation');
    const presets: RecommendedPreset[] = [];
    for (const entry of Array.isArray(input.presets) ? input.presets : []) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== 'string' || !row.id) continue;
        if (presets.some(({ id }) => id === row.id)) continue;
        presets.push({
            id: row.id,
            label: typeof row.label === 'string' ? row.label.slice(0, 80) : row.id,
            category: typeof row.category === 'string' ? row.category.slice(0, 80) : '',
            why: typeof row.why === 'string' ? row.why.slice(0, 300) : '',
            ...(typeof row.score === 'number' && Number.isFinite(row.score) ? { score: row.score } : {}),
        });
        if (presets.length >= PRODUCT_LIMITS.presets) break;
    }
    const terms = (list: unknown): string[] => {
        try {
            return normaliseTerms(list, 'interest').slice(0, PRODUCT_LIMITS.terms);
        } catch {
            return [];
        }
    };
    const networks = (Array.isArray(input.networks) ? input.networks : []).filter(isNetwork) as NetworkId[];
    const summary = typeof input.audienceSummary === 'string' ? input.audienceSummary.trim().slice(0, 400) : '';
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
    return {
        source: input.source === 'agent' ? 'agent' : 'ranker',
        presets,
        extraInterests: terms(input.extraInterests),
        avoid: terms(input.avoid),
        ...(summary ? { audienceSummary: summary } : {}),
        networks: [...new Set(networks)],
        ...(note ? { note } : {}),
        createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    };
}

export interface ValidateProductOptions {
    /** The product being edited, when this is an edit. Its id and createdAt are kept. */
    existing?: Product;
}

export function validateProduct(value: unknown, options: ValidateProductOptions = {}): Product {
    const input = object(value, 'Product');
    const existing = options.existing;
    const name = trimmed(input.name, 'Name', PRODUCT_LIMITS.name, existing === undefined)
        ?? existing?.name;
    if (!name) throw new ProductError('Name is required');
    const description = trimmed(input.description, 'Description', PRODUCT_LIMITS.description, existing === undefined)
        ?? existing?.description;
    if (!description) throw new ProductError('Description is required');
    const url = input.url === undefined ? existing?.url : productUrl(input.url);
    const audience = input.audience === undefined
        ? existing?.audience
        : trimmed(input.audience, 'Audience', PRODUCT_LIMITS.audience, false);
    const recommendation = input.recommendation === undefined
        ? existing?.recommendation
        : validateRecommendation(input.recommendation);
    return {
        id: existing?.id ?? (typeof input.id === 'string' && PRODUCT_ID_PATTERN.test(input.id.trim())
            ? input.id.trim()
            : crypto.randomUUID()),
        name,
        description,
        ...(url ? { url } : {}),
        ...(audience ? { audience } : {}),
        createdAt: existing?.createdAt ?? (typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString()),
        ...(recommendation ? { recommendation } : {}),
    };
}

/* ---- Store ------------------------------------------------------------- */

export function productStorePath(directory?: string): string {
    const root = directory ?? path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
    return path.join(root, 'products.json');
}

/** Newest first — a farm promotes the thing it added last far more often than the first one. */
export async function loadProducts(directory?: string): Promise<Product[]> {
    let raw: string;
    try {
        raw = await readFile(productStorePath(directory), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ProductError(`products.json contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { products?: unknown })?.products;
    const products: Product[] = [];
    for (const entry of Array.isArray(list) ? list : []) {
        // One bad entry must not blank the whole file for every other product.
        try {
            const product = validateProduct(entry, {
                existing: {
                    id: normaliseProductId((entry as Record<string, unknown>)?.id),
                    name: '', description: '',
                    createdAt: String((entry as Record<string, unknown>)?.createdAt ?? new Date().toISOString()),
                } as Product,
            });
            if (products.some(({ id }) => id === product.id)) continue;
            products.push(product);
        } catch { /* skipped */ }
    }
    return products.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function saveProducts(products: readonly Product[], directory?: string): Promise<void> {
    const target = productStorePath(directory);
    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(products, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, target);
}

// Two panels saving two products at once would otherwise each read the same file and the second
// write would drop the first — the guard `personas.json` and `devices.json` both use.
let storeMutation: Promise<unknown> = Promise.resolve();

export function mutateProducts<T>(mutate: (products: Product[]) => T | Promise<T>, directory?: string): Promise<T> {
    const run = storeMutation.then(async () => {
        const products = await loadProducts(directory);
        const result = await mutate(products);
        await saveProducts(products, directory);
        return result;
    });
    storeMutation = run.catch(() => undefined);
    return run;
}

export async function createProduct(value: unknown, directory?: string): Promise<Product> {
    const product = validateProduct(value);
    await mutateProducts((products) => { products.unshift(product); }, directory);
    return product;
}

export async function readProduct(id: string, directory?: string): Promise<Product | undefined> {
    const key = normaliseProductId(id);
    return (await loadProducts(directory)).find((product) => product.id === key);
}

/** Applies a patch to one product, or throws when there is no such product. */
export async function updateProduct(id: string, patch: unknown, directory?: string): Promise<Product> {
    const key = normaliseProductId(id);
    return mutateProducts((products) => {
        const index = products.findIndex((product) => product.id === key);
        if (index < 0) throw new ProductError('That product no longer exists');
        const updated = validateProduct(object(patch, 'Product'), { existing: products[index]! });
        products[index] = updated;
        return updated;
    }, directory);
}

export async function deleteProduct(id: string, directory?: string): Promise<boolean> {
    const key = normaliseProductId(id);
    return mutateProducts((products) => {
        const index = products.findIndex((product) => product.id === key);
        if (index < 0) return false;
        products.splice(index, 1);
        return true;
    }, directory);
}

/* ---- Applying one ------------------------------------------------------ */

export interface ApplyInput {
    handle: string;
    /** Preset ids, in the order they should blend. The operator may have unticked some. */
    presets: readonly string[];
    extraInterests?: readonly string[];
    avoid?: readonly string[];
    productId?: string;
}

/**
 * The persona a recommendation produces for one handle: the chosen presets blended exactly as the
 * picker blends them, then the extra interests appended and the extra avoid terms added.
 *
 * Two rules keep the result sane, and they are the blend's own rules rather than new ones: the
 * lists stop at `LIMITS.terms` rather than being silently truncated somewhere lower, and a term
 * that is already an interest never also becomes an avoid term — a product about crypto must not
 * produce an account that scrolls past the word crypto.
 */
export function personaForProduct(input: ApplyInput): Persona {
    const handle = normaliseHandle(input.handle);
    const blended = blendPresets(handle, [...input.presets]);
    const interests = [...blended.interests];
    for (const term of normaliseTerms(input.extraInterests ?? [], 'interest')) {
        if (interests.length >= LIMITS.terms) break;
        if (!interests.includes(term)) interests.push(term);
    }
    const avoid = [...blended.avoid];
    for (const term of normaliseTerms(input.avoid ?? [], 'avoid')) {
        if (avoid.length >= LIMITS.terms) break;
        if (!avoid.includes(term) && !interests.includes(term)) avoid.push(term);
    }
    return validatePersona(handle, {
        ...(blended as unknown as Record<string, unknown>),
        interests,
        avoid,
        ...(input.productId ? { productId: normaliseProductId(input.productId) } : {}),
    });
}

/** Turns a `PersonaError` from the blend into a `ProductError`, so one panel reports one kind. */
export function applyError(error: unknown): ProductError {
    if (error instanceof ProductError) return error;
    if (error instanceof PersonaError) return new ProductError(error.message);
    return new ProductError(error instanceof Error ? error.message : String(error));
}
