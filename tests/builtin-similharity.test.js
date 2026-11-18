/**
 * Built-in Similharity shim contract tests.
 *
 * These pin the response shapes that VectTauri consumers rely on (see
 * D:\Kilo Projects\VectTauri-Builtin-Mode-Plan.md §3). The shim is exercised
 * through builtinFetch() with the settings fallback store (no TauriTavern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock host modules before importing the shim
vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-token',
    })),
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: {
        vecttauri: {},
    },
}));

// Deterministic stand-in for ST's getStringHash (loaded lazily by PATCH /text).
vi.mock('../../../../utils.js', () => ({
    getStringHash: (str) => String(str).split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000003, 7),
}));

import { builtinFetch, isBuiltinRoute, BUILTIN_PLUGIN_VERSION } from '../utils/builtin-similharity.js';
import { resetBuiltinStoreProbe } from '../utils/builtin-store.js';

const H = '/api/plugins/similharity';

function post(path, body) {
    return builtinFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

describe('builtin shim routing', () => {
    beforeEach(() => {
        resetBuiltinStoreProbe();
    });

    it('routes health to a green builtin response', async () => {
        const r = await builtinFetch(`${H}/health`, { method: 'GET' });
        expect(r.ok).toBe(true);
        const data = await r.json();
        expect(data.status).toBe('ok');
        expect(data.version).toBe(BUILTIN_PLUGIN_VERSION);
        expect(data.features).toContain('native-vector');
    });

    it('recognizes all consumed plugin paths as builtin routes', () => {
        const paths = [
            `${H}/health`,
            `${H}/collections`,
            `${H}/chunks/insert`,
            `${H}/chunks/list`,
            `${H}/chunks/query`,
            `${H}/chunks/delete`,
            `${H}/chunks/purge`,
            `${H}/chunks/stats`,
            `${H}/chunks/collection-metadata`,
            `${H}/chunks/ensure-eventbase-indexes`,
            `${H}/purge-all`,
            `${H}/get-embedding`,
        ];
        for (const p of paths) {
            expect(isBuiltinRoute(p)).toBe(true);
        }
        expect(isBuiltinRoute('/api/vector/insert')).toBe(false);
        expect(isBuiltinRoute('/api/plugins/other/health')).toBe(false);
    });

    it('returns 404 for unknown plugin routes', async () => {
        const r = await post(`${H}/chunks/nonexistent`, {});
        expect(r.ok).toBe(false);
        expect(r.status).toBe(404);
    });
});

describe('builtin shim chunks contract', () => {
    beforeEach(() => {
        resetBuiltinStoreProbe();
    });

    it('insert validates required fields', async () => {
        const r = await post(`${H}/chunks/insert`, {});
        expect(r.status).toBe(400);
    });

    it('insert → list round-trips metadata with paging', async () => {
        // insert calls native /api/vector/insert via global fetch — stub it.
        const nativeCalls = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            nativeCalls.push({ url, init });
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        };
        try {
            const items = [
                { hash: 'h2', text: 'two', index: 1, vector: [0, 1], metadata: { importance: 150, keywords: ['b'] } },
                { hash: 'h1', text: 'one', index: 0, vector: [1, 0], metadata: { importance: 100, keywords: ['a'] } },
                { hash: 'h3', text: 'three', index: 2, vector: [1, 1], metadata: {} },
            ];
            const ins = await post(`${H}/chunks/insert`, {
                backend: 'vectra', collectionId: 'similharity_chat_A', items,
                source: 'transformers', model: 'Xenova/test-model',
            });
            expect(ins.ok).toBe(true);
            const insData = await ins.json();
            expect(insData.success).toBe(true);
            expect(insData.inserted).toBe(3);
            expect(nativeCalls.some(c => String(c.url).includes('/api/vector/insert'))).toBe(true);

            const list = await post(`${H}/chunks/list`, {
                backend: 'vectra', collectionId: 'similharity_chat_A', offset: 0, limit: 2,
            });
            const listData = await list.json();
            expect(listData.success).toBe(true);
            expect(listData.total).toBe(3);
            expect(listData.items).toHaveLength(2);
            // deterministic ordering (sorted by hash)
            expect(listData.items.map(i => i.hash)).toEqual(['h1', 'h2']);
            expect(listData.items[1].metadata.importance).toBe(150);

            const page2 = await post(`${H}/chunks/list`, {
                backend: 'vectra', collectionId: 'similharity_chat_A', offset: 2, limit: 2, includeVectors: true,
            });
            const page2Data = await page2.json();
            expect(page2Data.items).toHaveLength(1);
            expect(page2Data.items[0].vector).toEqual([1, 1]);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('strips a backend prefix so list/query read the same namespace insert wrote', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            const ins = await post(`${H}/chunks/insert`, {
                backend: 'vectra', collectionId: 'vf_eventbase_standard_hero_abc123',
                source: 'transformers', model: 'm',
                items: [{ hash: 'h1', text: 'remembered', index: 0, vector: [1, 0], metadata: { importance: 120 } }],
            });
            expect(ins.ok).toBe(true);

            // Read back via the registry-key form (with the "builtin:" backend prefix
            // the Database Browser / export actually pass) — must hit the same namespace.
            const list = await post(`${H}/chunks/list`, { backend: 'builtin', collectionId: 'builtin:vf_eventbase_standard_hero_abc123' });
            const listData = await list.json();
            expect(listData.total).toBe(1);
            expect(listData.items[0].hash).toBe('h1');
            expect(listData.items[0].metadata.importance).toBe(120);

            const stats = await post(`${H}/chunks/stats`, { collectionId: 'vectra:vf_eventbase_standard_hero_abc123' });
            const statsData = await stats.json();
            expect(statsData.stats.chunkCount).toBe(1);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('query scores client-side from queryVector and honors threshold + topK', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-q', source: 'transformers', model: 'm',
                items: [
                    { hash: 'a', text: 'alpha', index: 0, vector: [1, 0], metadata: { importance: 100 } },
                    { hash: 'b', text: 'beta', index: 1, vector: [0, 1], metadata: { importance: 100 } },
                    { hash: 'c', text: 'gamma', index: 2, vector: [0.9, 0.1], metadata: { importance: 100 } },
                ],
            });

            const r = await post(`${H}/chunks/query`, {
                collectionId: 'c-q', topK: 2, threshold: 0.5, queryVector: [1, 0],
            });
            const data = await r.json();
            expect(data.success).toBe(true);
            expect(data.count).toBe(2);
            expect(data.results[0].hash).toBe('a');
            expect(data.results[0].score).toBeCloseTo(1, 5);
            expect(data.results[0].text).toBe('alpha');
            expect(data.results[1].hash).toBe('c');
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('maps numeric hashes from the native query response { hashes: [i64] }', async () => {
        // TauriTavern's /api/vector/query answers { hashes: [i64, ...], metadata: [...] }.
        // Those hashes are NUMBERS with no score, so the shim must not read `.hash`
        // off them (undefined) — that used to drop every hit and make retrieval
        // report "no events matched" even though the collection was full.
        const realFetch = globalThis.fetch;
        const HASH_A = 1191389692891003;
        const HASH_B = 2267538684203703;
        globalThis.fetch = async (url) => {
            if (String(url).includes('/api/vector/query')) {
                const payload = { hashes: [HASH_A, HASH_B], metadata: [{}, {}] };
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify(payload),
                    json: async () => payload,
                };
            }
            return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
        };
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-native', source: 'ollama', model: 'snowflake-arctic-embed',
                items: [
                    { hash: HASH_A, text: 'yorichi vs gojo', index: 0, metadata: { importance: 100 } },
                    { hash: HASH_B, text: 'solar flare', index: 1, metadata: { importance: 100 } },
                ],
            });

            const r = await post(`${H}/chunks/query`, {
                collectionId: 'c-native', topK: 5, threshold: 0.25,
                searchText: 'yorichi', source: 'ollama', model: 'snowflake-arctic-embed',
            });
            const data = await r.json();
            expect(data.success).toBe(true);
            expect(data.count).toBe(2);
            expect(data.results.map(x => x.hash)).toEqual([HASH_A, HASH_B]);
            expect(data.results[0].text).toBe('yorichi vs gojo');
            expect(data.results[0].score).toBeGreaterThan(0);
            // Native ordering (similarity desc) must be preserved by the ramp.
            expect(data.results[0].score).toBeGreaterThan(data.results[1].score);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('query requires queryVector or searchText', async () => {
        const r = await post(`${H}/chunks/query`, { collectionId: 'c-x' });
        expect(r.status).toBe(400);
    });

    it('delete, purge and stats operate on the metadata store', async () => {
        const realFetch = globalThis.fetch;
        const nativeCalls = [];
        globalThis.fetch = async (url, init) => {
            nativeCalls.push({ url: String(url), init });
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        };
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-del', source: 'transformers', model: 'm',
                items: [
                    { hash: 'h1', text: 'x', index: 0, vector: [1], metadata: { importance: 5 } },
                    { hash: 'h2', text: 'y', index: 1, vector: [1], metadata: {} },
                ],
            });

            const del = await post(`${H}/chunks/delete`, { collectionId: 'c-del', hashes: ['h1'] });
            expect(del.ok).toBe(true);
            expect(nativeCalls.some(c => c.url.includes('/api/vector/delete'))).toBe(true);

            const stats1 = await post(`${H}/chunks/stats`, { collectionId: 'c-del' });
            const stats1Data = await stats1.json();
            expect(stats1Data.stats.chunkCount).toBe(1);

            const purge = await post(`${H}/chunks/purge`, { collectionId: 'c-del' });
            expect(purge.ok).toBe(true);
            expect(nativeCalls.some(c => c.url.includes('/api/vector/purge'))).toBe(true);

            const stats2 = await post(`${H}/chunks/stats`, { collectionId: 'c-del' });
            const stats2Data = await stats2.json();
            expect(stats2Data.stats.chunkCount).toBe(0);
            expect(stats2Data.stats.exists).toBe(false);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('collections lists registered collections with counts', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'similharity_global', source: 'qdrant', model: 'm',
                items: [{ hash: 'k1', text: 't', index: 0, vector: [0], metadata: {} }],
            });
            const r = await builtinFetch(`${H}/collections`, { method: 'GET' });
            const data = await r.json();
            expect(data.success).toBe(true);
            const entry = data.collections.find(c => c.id === 'similharity_global');
            expect(entry).toBeTruthy();
            expect(entry.backend).toBe('builtin');
            expect(entry.chunkCount).toBe(1);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('collection-metadata reports chunk totals', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-meta', source: 'transformers', model: 'Xenova/m',
                items: [{ hash: 'z', text: 'text-here', index: 0, vector: [0], metadata: {} }],
            });
            const r = await post(`${H}/chunks/collection-metadata`, { collectionId: 'c-meta' });
            const data = await r.json();
            expect(data.success).toBe(true);
            expect(data.info.totalChunks).toBe(1);
            expect(data.info.models[0].name).toBe('Xenova/m');
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('eventbase indexes is a no-op success', async () => {
        const r = await post(`${H}/chunks/ensure-eventbase-indexes`, {});
        const data = await r.json();
        expect(data.success).toBe(true);
    });

    it('get-embedding returns a clear 501 in builtin mode', async () => {
        const r = await post(`${H}/get-embedding`, { text: 'hello' });
        expect(r.status).toBe(501);
    });
});

describe('builtin shim cross-chat scoping', () => {
    beforeEach(() => {
        resetBuiltinStoreProbe();
    });

    it('registry is global: collections registered in one chat context are listed from another', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            // Register a collection (registry writes go to extension_settings — global).
            await post(`${H}/chunks/insert`, {
                collectionId: 'vf_chat_A_1', source: 'transformers', model: 'm',
                items: [{ hash: 'x1', text: 't', index: 0, vector: [0], metadata: {} }],
            });

            // Simulate switching chats: chunk metadata store is per-chat in TT,
            // but the registry namespace must survive the switch. Verify the
            // registry data physically lives in extension_settings (global).
            const { extension_settings } = await import('../../../../extensions.js');
            const globalTree = extension_settings.vecttauri.builtinGlobal;
            expect(globalTree.__vecttauri_registry.vf_chat_A_1).toBeTruthy();

            // Collections listing reads the global registry, not a chat store.
            const r = await builtinFetch(`${H}/collections`, { method: 'GET' });
            const data = await r.json();
            const entry = data.collections.find(c => c.id === 'vf_chat_A_1');
            expect(entry).toBeTruthy();
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('chunk metadata is keyed per collection, so distinct chats never mix', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'vf_chat_A_1', source: 'transformers', model: 'm',
                items: [{ hash: 'onlyA', text: 'chat A chunk', index: 0, vector: [1], metadata: {} }],
            });
            await post(`${H}/chunks/insert`, {
                collectionId: 'vf_chat_B_2', source: 'transformers', model: 'm',
                items: [{ hash: 'onlyB', text: 'chat B chunk', index: 0, vector: [1], metadata: {} }],
            });

            const listA = await post(`${H}/chunks/list`, { collectionId: 'vf_chat_A_1' });
            const a = (await listA.json()).items.map(i => i.hash);
            expect(a).toContain('onlyA');
            expect(a).not.toContain('onlyB');
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('builtin shim hybrid keyword boost', () => {
    beforeEach(() => {
        resetBuiltinStoreProbe();
    });

    it('keyword match lifts a weaker dense result above a stronger one', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            // Unit vectors chosen so dense scores are 0.9 and 0.85 pre-boost.
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-hybrid', source: 'transformers', model: 'm',
                items: [
                    {
                        // Dense winner (0.9), but no keyword overlap with the query.
                        hash: 'dense-win', text: 'the weather was pleasant', index: 0,
                        vector: [0.9, 0.43589], metadata: { importance: 100, keywords: ['weather'] },
                    },
                    {
                        // Dense runner-up (0.85); one keyword match → 1.15x boost
                        // (1 + 0.5 contribution × 0.3 single-match scale) → 0.9775.
                        hash: 'kw-win', text: 'a dragon attacked the village', index: 1,
                        vector: [0.85, 0.52678], metadata: { importance: 100, keywords: ['dragon'] },
                    },
                ],
            });

            const r = await post(`${H}/chunks/query`, {
                collectionId: 'c-hybrid', topK: 2, threshold: 0,
                queryVector: [1, 0], searchText: 'dragon attack on the village',
            });
            const data = await r.json();
            expect(data.success).toBe(true);
            expect(data.results[0].hash).toBe('kw-win');
            expect(data.results[0].keywordBoosted).toBe(true);
            expect(data.results[0].originalScore).toBeCloseTo(0.85, 2);
            expect(data.results[0].score).toBeGreaterThan(data.results[1].score);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('query without searchText skips boosting (pure dense)', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-pure', source: 'transformers', model: 'm',
                items: [
                    { hash: 'a', text: 'alpha', index: 0, vector: [1, 0], metadata: { keywords: ['alpha'] } },
                    { hash: 'b', text: 'beta', index: 1, vector: [0.9, 0.1], metadata: { keywords: [] } },
                ],
            });

            const r = await post(`${H}/chunks/query`, {
                collectionId: 'c-pure', topK: 2, threshold: 0, queryVector: [1, 0],
            });
            const data = await r.json();
            for (const res of data.results) {
                expect(res.keywordBoosted).toBeFalsy();
                expect(res.originalScore).toBeUndefined();
            }
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('forwards provider fields (apiUrl) to the native insert for URL-based sources', async () => {
        // TT's Rust backend validates apiUrl for vllm/ollama/llamacpp sources;
        // dropping it produced "Bad request: apiUrl is required" mid-vectorization.
        const nativeBodies = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/api/vector/insert')) {
                nativeBodies.push(JSON.parse(init.body));
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        };
        try {
            const r = await post(`${H}/chunks/insert`, {
                backend: 'vectra', collectionId: 'c-url', source: 'vllm', model: 'my-model',
                apiUrl: 'http://192.168.88.251:8000/v1',
                items: [{ hash: 'u1', text: 'chunk', index: 0, vector: [1], metadata: {} }],
            });
            expect(r.ok).toBe(true);
            expect(nativeBodies).toHaveLength(1);
            expect(nativeBodies[0].source).toBe('vllm');
            expect(nativeBodies[0].apiUrl).toBe('http://192.168.88.251:8000/v1');
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('forwards apiUrl to the native query for URL-based sources', async () => {
        const nativeBodies = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/api/vector/query')) {
                nativeBodies.push(JSON.parse(init.body));
                return { ok: true, status: 200, json: async () => ({ hashes: [] }), text: async () => '' };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        };
        try {
            await post(`${H}/chunks/insert`, {
                collectionId: 'c-url-q', source: 'vllm', model: 'my-model', apiUrl: 'http://host:8000/v1',
                items: [{ hash: 'q1', text: 'chunk', index: 0, vector: [1], metadata: {} }],
            });
            await post(`${H}/chunks/query`, {
                collectionId: 'c-url-q', topK: 5, threshold: 0,
                searchText: 'hello', source: 'vllm', model: 'my-model', apiUrl: 'http://host:8000/v1',
            });
            expect(nativeBodies[nativeBodies.length - 1].apiUrl).toBe('http://host:8000/v1');
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('treats a successful native insert with an EMPTY body as success (TT empty_response)', async () => {
        // TT answers successful insert/delete/purge with Response(null). Parsing
        // that as JSON threw SyntaxError, which the shim reported as a 500 —
        // turning successful writes into "insert failed after 3 retries".
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            // Mimic a Response(null) body: empty text, and json() that throws.
            text: async () => '',
            json: async () => { throw new SyntaxError('Unexpected end of input'); },
        });
        try {
            const r = await post(`${H}/chunks/insert`, {
                collectionId: 'c-empty', source: 'ollama', model: 'embeddinggemma', apiUrl: 'http://127.0.0.1:11434',
                items: [{ hash: 'e1', text: 'chunk', index: 0, vector: [1], metadata: {} }],
            });
            expect(r.ok).toBe(true);
            const data = await r.json();
            expect(data.success).toBe(true);
            expect(data.inserted).toBe(1);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});


describe('builtin shim per-chunk routes (plugin parity)', () => {
    const COL = 'similharity_chunkroutes';
    let nativeCalls;
    let realFetch;

    const patch = (path, body) => builtinFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
    const get = (path) => builtinFetch(path, { method: 'GET' });

    beforeEach(async () => {
        resetBuiltinStoreProbe();
        nativeCalls = [];
        realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            nativeCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        };
        await post(`${H}/chunks/purge`, { collectionId: COL });
        await post(`${H}/chunks/insert`, {
            collectionId: COL, source: 'transformers', model: 'm',
            items: [{ hash: 111, text: 'alpha', index: 3, metadata: { keywords: ['a'], enabled: true } }],
        });
        nativeCalls = [];
    });

    afterEach(() => { globalThis.fetch = realFetch; });

    it('recognizes the dynamic chunk paths, but not the fixed routes, as hash routes', () => {
        expect(isBuiltinRoute(`${H}/chunks/111`)).toBe(true);
        expect(isBuiltinRoute(`${H}/chunks/-42/text`)).toBe(true);
        expect(isBuiltinRoute(`${H}/chunks/111/metadata`)).toBe(true);
        expect(isBuiltinRoute(`${H}/chunks/111?collectionId=x`)).toBe(true);
        expect(isBuiltinRoute(`${H}/chunks/nope`)).toBe(false);
    });

    it('GET /chunks/:hash returns the chunk, 404 when missing, 400 without collectionId', async () => {
        const hit = await get(`${H}/chunks/111?collectionId=${COL}&backend=vectra`);
        const data = await hit.json();
        expect(data.success).toBe(true);
        expect(data.chunk).toMatchObject({ hash: 111, text: 'alpha', index: 3 });
        expect(data.chunk.metadata.keywords).toEqual(['a']);

        expect((await get(`${H}/chunks/999?collectionId=${COL}`)).status).toBe(404);
        expect((await get(`${H}/chunks/111`)).status).toBe(400);
    });

    it('PATCH metadata merges, protects hash/text, and makes no native call', async () => {
        const r = await patch(`${H}/chunks/111/metadata`, {
            collectionId: COL, metadata: { keywords: ['a', 'b'], hash: 5, text: 'evil', name: 'N' },
        });
        const data = await r.json();
        expect(data.success).toBe(true);
        expect(data.metadata).toEqual({ keywords: ['a', 'b'], enabled: true, name: 'N' });

        const chunk = (await (await get(`${H}/chunks/111?collectionId=${COL}`)).json()).chunk;
        expect(chunk.text).toBe('alpha');
        expect(chunk.hash).toBe(111);
        expect(chunk.metadata.enabled).toBe(true);
        expect(nativeCalls).toHaveLength(0);
    });

    it('PATCH metadata validates input and reports unknown chunks', async () => {
        expect((await patch(`${H}/chunks/111/metadata`, { collectionId: COL })).status).toBe(400);
        expect((await patch(`${H}/chunks/999/metadata`, { collectionId: COL, metadata: { a: 1 } })).status).toBe(404);
    });

    it('PATCH text re-embeds via the native store: inserts the new hash, deletes the old, keeps metadata', async () => {
        const r = await patch(`${H}/chunks/111/text`, { collectionId: COL, text: 'beta', source: 'transformers', model: 'm' });
        const data = await r.json();
        expect(data.success).toBe(true);
        expect(data.oldHash).toBe(111);
        expect(data.newHash).not.toBe(111);
        expect(data.text).toBe('beta');

        const calls = nativeCalls.map(c => c.url.replace(/^.*\/api\/vector\//, ''));
        // New point is written BEFORE the old one is removed.
        expect(calls).toEqual(['insert', 'delete']);
        expect(nativeCalls[0].body.items).toEqual([{ hash: data.newHash, text: 'beta', index: 3 }]);
        expect(nativeCalls[1].body.hashes).toEqual([111]);

        expect((await get(`${H}/chunks/111?collectionId=${COL}`)).status).toBe(200); // via alias
        const moved = (await (await get(`${H}/chunks/${data.newHash}?collectionId=${COL}`)).json()).chunk;
        expect(moved.text).toBe('beta');
        expect(moved.metadata.keywords).toEqual(['a']);
    });

    it('a metadata write using the OLD hash right after a text edit still lands (saveAllChanges order)', async () => {
        const t = await (await patch(`${H}/chunks/111/text`, { collectionId: COL, text: 'gamma', source: 'transformers' })).json();
        const m = await patch(`${H}/chunks/111/metadata`, { collectionId: COL, metadata: { enabled: false } });
        expect(m.ok).toBe(true);
        const moved = (await (await get(`${H}/chunks/${t.newHash}?collectionId=${COL}`)).json()).chunk;
        expect(moved.metadata.enabled).toBe(false);
    });

    it('PATCH text refuses client-embedded sources instead of writing a vector-less chunk', async () => {
        const r = await patch(`${H}/chunks/111/text`, { collectionId: COL, text: 'delta', source: 'custom' });
        expect(r.status).toBe(501);
        expect(nativeCalls).toHaveLength(0);
        expect((await (await get(`${H}/chunks/111?collectionId=${COL}`)).json()).chunk.text).toBe('alpha');
    });

    it('PATCH text with text that hashes to the same value makes no native call', async () => {
        const { getStringHash } = await import('../../../../utils.js');
        const sameHash = getStringHash('same text');
        await post(`${H}/chunks/insert`, {
            collectionId: COL, source: 'transformers', model: 'm',
            items: [{ hash: sameHash, text: 'same text', index: 0 }],
        });
        nativeCalls = [];
        const r = await (await patch(`${H}/chunks/${sameHash}/text`, { collectionId: COL, text: 'same text', source: 'transformers' })).json();
        expect(r.success).toBe(true);
        expect(r.newHash).toBe(r.oldHash);
        expect(nativeCalls).toHaveLength(0);
    });

    it('rejects unsupported methods on chunk paths', async () => {
        expect((await builtinFetch(`${H}/chunks/111/text`, { method: 'GET' })).status).toBe(405);
        expect((await builtinFetch(`${H}/chunks/111`, { method: 'DELETE' })).status).toBe(405);
    });
});

describe('builtin shim list / stats parity with the plugin', () => {
    const COL = 'similharity_paritystats';
    let realFetch;
    beforeEach(async () => {
        resetBuiltinStoreProbe();
        realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        await post(`${H}/chunks/purge`, { collectionId: COL });
        await post(`${H}/chunks/insert`, {
            collectionId: COL, source: 'transformers', model: 'm',
            items: [
                { hash: 1, text: 'abcd', index: 0, vector: [1, 0, 0], metadata: { originalMessageHash: 'x' } },
                { hash: 2, text: 'abcdefgh', index: 1, metadata: { originalMessageHash: 'x' } },
                { hash: 3, text: 'abcd', index: 2, metadata: { originalMessageHash: 'y' } },
            ],
        });
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    it('list: limit 0/absent returns everything; paging reports offset/limit/hasMore', async () => {
        const all = await (await post(`${H}/chunks/list`, { collectionId: COL })).json();
        expect(all.items).toHaveLength(3);
        expect(all).toMatchObject({ total: 3, offset: 0, limit: 0, hasMore: false });

        const p1 = await (await post(`${H}/chunks/list`, { collectionId: COL, offset: 0, limit: 2 })).json();
        expect(p1).toMatchObject({ total: 3, offset: 0, limit: 2, hasMore: true });
        const p2 = await (await post(`${H}/chunks/list`, { collectionId: COL, offset: 2, limit: 2 })).json();
        expect(p2).toMatchObject({ offset: 2, limit: 2, hasMore: false });
        expect(p2.items).toHaveLength(1);
    });

    it('stats: plugin-shaped fields plus the legacy builtin ones', async () => {
        const r = await (await post(`${H}/chunks/stats`, { collectionId: COL })).json();
        expect(r.backend).toBe('vectra');
        expect(r.stats).toMatchObject({
            chunkCount: 3, totalCharacters: 16, totalTokens: 4, avgChunkSize: 5,
            embeddingDimensions: 3, messageCount: 2, storageSize: 0, backend: 'vectra',
            sources: { transformers: 3 },
            // legacy
            totalSize: 16, exists: true, model: 'm', source: 'transformers',
        });
    });

    it('stats on an empty collection is all zeros, not an error', async () => {
        const r = await (await post(`${H}/chunks/stats`, { collectionId: 'similharity_nothing_here' })).json();
        expect(r.stats).toMatchObject({ chunkCount: 0, totalCharacters: 0, avgChunkSize: 0, exists: false, sources: {} });
    });
});

describe('builtin shim query score honesty', () => {
    const COL = 'similharity_scores';
    let realFetch;
    beforeEach(async () => {
        resetBuiltinStoreProbe();
        realFetch = globalThis.fetch;
        await post(`${H}/chunks/purge`, { collectionId: COL });
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
        await post(`${H}/chunks/insert`, {
            collectionId: COL, source: 'transformers', model: 'm',
            items: [{ hash: 1, text: 'one', index: 0 }, { hash: 2, text: 'two', index: 1 }],
        });
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    const nativeReturns = (payload) => {
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    };

    it('flags rank-derived scores as synthetic when the native store returns no scores', async () => {
        nativeReturns({ hashes: [2, 1], metadata: [] });
        const r = await (await post(`${H}/chunks/query`, { collectionId: COL, searchText: 'q', topK: 5 })).json();
        expect(r.scoresSynthetic).toBe(true);
        expect(r.results.map(x => x.hash)).toEqual([2, 1]);          // native ORDER is preserved
        expect(r.results[0].score).toBeGreaterThan(r.results[1].score);
    });

    it('uses real scores when the native store provides them, and does not flag them', async () => {
        nativeReturns({ hashes: [2, 1], metadata: [], scores: [0.91, 0.42] });
        const r = await (await post(`${H}/chunks/query`, { collectionId: COL, searchText: 'q', topK: 5 })).json();
        expect(r.scoresSynthetic).toBe(false);
        expect(r.results.map(x => x.score)).toEqual([0.91, 0.42]);
    });

    it('client-side cosine path (stored vectors) is never flagged synthetic', async () => {
        await post(`${H}/chunks/insert`, {
            collectionId: COL, source: 'custom', model: 'm',
            items: [{ hash: 7, text: 'v', index: 0, vector: [1, 0] }],
        });
        const r = await (await post(`${H}/chunks/query`, { collectionId: COL, queryVector: [1, 0], topK: 5 })).json();
        expect(r.scoresSynthetic).toBe(false);
        expect(r.results.find(x => x.hash === 7).score).toBeCloseTo(1, 5);
    });
});
