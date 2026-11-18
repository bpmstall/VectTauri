/**
 * Story State — parsing / truncation / guards, the incremental update flow with a
 * mocked LLM, undo, lock, per-chat isolation, the extraction hook's window
 * counting, and the injection block.
 *
 * Host modules (script.js, extensions.js, secrets) don't resolve under vitest, so
 * they are mocked, as in the sibling tests. prompts-i18n.js, constants.js,
 * feature-gate.js, text-cleaning.js and string-utils.js stay real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    class LlmCallError extends Error {
        constructor(message, { kind, status = null, provider = null } = {}) {
            super(message);
            this.name = 'LlmCallError';
            this.kind = kind;
            this.status = status;
            this.provider = provider;
        }
    }
    return {
        LlmCallError,
        extensionSettings: { vecttauri: {} },
        extensionPrompts: {},
        setExtensionPrompt: vi.fn(),
        saveSettingsDebounced: vi.fn(),
        postChatCompletion: vi.fn(),
        notifyInvalidModel: vi.fn(),
        chatUUID: { value: 'uuid-1' },
        log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), domain: vi.fn(), enabled: () => false, domainEnabled: () => false },
    };
});

vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: mocks.setExtensionPrompt,
    saveSettingsDebounced: mocks.saveSettingsDebounced,
    extension_prompts: mocks.extensionPrompts,
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: mocks.extensionSettings }));
vi.mock('../../../../utils.js', () => ({ uuidv4: vi.fn(() => 'x') }));
vi.mock('../core/collection-ids.js', () => ({ getChatUUID: () => mocks.chatUUID.value }));
vi.mock('../core/api-keys.js', () => ({ getLlmOpenRouterApiKey: vi.fn(() => 'key'), getLlmCustomApiKey: vi.fn(() => 'key') }));
vi.mock('../core/llm-provider-call.js', () => ({
    postChatCompletion: mocks.postChatCompletion,
    resolveModelParameterStyle: vi.fn(() => ({})),
    resolveLlmCredentials: vi.fn(() => ({})),
    LlmCallError: mocks.LlmCallError,
}));
vi.mock('../core/model-config-notifier.js', () => ({
    isInvalidModelConfigError: (e) => e?.code === 'invalid_model_config',
    notifyInvalidModel: mocks.notifyInvalidModel,
}));
vi.mock('../utils/llm-config-store.js', () => ({ resolveLlmEffectiveSettings: (s) => ({ ...(s || {}) }) }));
vi.mock('../core/log.js', () => ({ log: mocks.log }));

import {
    resolveStoryStateConfig, truncateAtLine, parseStoryStateReply, isSuspectShrink, buildStoryStateBlock,
    getStoryStateRecord, getStoryStateText, setStoryStateText, clearStoryState, undoStoryState,
    updateStoryState, onExtractionRun, runStoryStateInjection, formatMessagesForStoryState,
    rebuildStoryState, takeBackfillChunk, estimateRebuildCalls, onFullIngestionRun,
} from '../core/story-state.js';
import { STORY_STATE_PROMPT_TAG } from '../core/constants.js';

const NOTE_A = 'SITUATION\n- Night, the tavern; Mara is present.\nPLAYER CHARACTER\n- Arrived on Earth about a week ago.';
const NOTE_B = 'SITUATION\n- Morning, the road; Mara and Jon travel.\nPLAYER CHARACTER\n- Arrived on Earth about a week ago.\nGOALS AND OPEN THREADS\n- Find the key.';
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ mes: `message ${i}`, name: i % 2 ? 'AI' : 'User', is_user: i % 2 === 0 }));
const reply = (content) => mocks.postChatCompletion.mockResolvedValueOnce({ content });

const BASE_SETTINGS = (over = {}) => ({
    story_state_enabled: true,
    story_state_update_every: 3,
    story_state_max_chars: 1800,
    chat_provider: 'openrouter',
    chat_model: 'm/model',
    position: 1,
    depth: 4,
    ...over,
});

beforeEach(() => {
    mocks.extensionSettings.vecttauri = {};
    mocks.chatUUID.value = 'uuid-1';
    vi.clearAllMocks();
    mocks.postChatCompletion.mockReset();
});

describe('resolveStoryStateConfig', () => {
    it('is off with the documented defaults when settings are missing', () => {
        expect(resolveStoryStateConfig(undefined)).toEqual({ enabled: false, locked: false, updateEvery: 3, maxTokens: 700, maxChars: 1800 });
    });
    it('clamps out-of-range values', () => {
        const c = resolveStoryStateConfig({ story_state_enabled: true, story_state_update_every: 99, story_state_max_tokens: 1, story_state_max_chars: 'x' });
        expect(c).toMatchObject({ enabled: true, updateEvery: 20, maxTokens: 100, maxChars: 1800 });
    });
});

describe('truncateAtLine', () => {
    it('leaves short text alone and cuts only on a line boundary', () => {
        expect(truncateAtLine('a\nb', 10)).toBe('a\nb');
        const out = truncateAtLine('aaaa\nbbbb\ncccc', 10);
        expect(out).toBe('aaaa\nbbbb');
        expect('aaaa\nbbbb\ncccc'.split('\n')).toEqual(expect.arrayContaining(out.split('\n')));
    });
    it('returns empty when even the first line does not fit', () => {
        expect(truncateAtLine('x'.repeat(50), 10)).toBe('');
    });
});

describe('parseStoryStateReply', () => {
    it('accepts a well-formed note and drops a preamble before the first header', () => {
        const r = parseStoryStateReply(`Sure, here it is:\n\n${NOTE_A}`);
        expect(r).toEqual({ ok: true, text: NOTE_A });
    });
    it('strips reasoning blocks and code fences', () => {
        const r = parseStoryStateReply(`<think>hmm</think>\n\`\`\`\n${NOTE_A}\n\`\`\``);
        expect(r).toEqual({ ok: true, text: NOTE_A });
    });
    it('accepts markdown-ish headers', () => {
        expect(parseStoryStateReply('## SITUATION:\n- x').ok).toBe(true);
        expect(parseStoryStateReply('**Player Character**\n- x').ok).toBe(true);
    });
    it('rejects empty, JSON and header-less replies', () => {
        expect(parseStoryStateReply('')).toEqual({ ok: false, reason: 'empty' });
        expect(parseStoryStateReply('<think>only thoughts</think>').ok).toBe(false);
        expect(parseStoryStateReply('{"situation": "x"}')).toEqual({ ok: false, reason: 'garbled' });
        expect(parseStoryStateReply('Just some prose about the story.')).toEqual({ ok: false, reason: 'garbled' });
    });
    it('hard-caps on a line boundary', () => {
        const long = 'SITUATION\n' + Array.from({ length: 100 }, (_, i) => `- line number ${i}`).join('\n');
        const r = parseStoryStateReply(long, { maxChars: 200 });
        expect(r.ok).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(200);
        expect(r.text.split('\n').every(l => l === 'SITUATION' || /^- line number \d+$/.test(l))).toBe(true);
    });
});

describe('isSuspectShrink', () => {
    it('flags a reply under 30% of a previous note longer than 300 chars', () => {
        expect(isSuspectShrink('x'.repeat(400), 'y'.repeat(100))).toBe(true);
        expect(isSuspectShrink('x'.repeat(400), 'y'.repeat(130))).toBe(false);
    });
    it('does not apply to short previous notes', () => {
        expect(isSuspectShrink('x'.repeat(300), 'y')).toBe(false);
        expect(isSuspectShrink('', 'y')).toBe(false);
    });
});

describe('buildStoryStateBlock', () => {
    it('labels the block and is empty for an empty note', () => {
        const block = buildStoryStateBlock(NOTE_A);
        expect(block).toContain('Current story state — treat as true');
        expect(block).toContain(NOTE_A);
        expect(block.startsWith('<VectTauriStoryState>')).toBe(true);
        expect(buildStoryStateBlock('  \n ')).toBe('');
    });
});

describe('storage', () => {
    it('keeps notes per chat and never leaks between chats', () => {
        setStoryStateText('uuid-1', NOTE_A);
        setStoryStateText('uuid-2', NOTE_B);
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
        expect(getStoryStateText('uuid-2')).toBe(NOTE_B);
        expect(getStoryStateText('uuid-3')).toBe('');
        clearStoryState('uuid-1');
        expect(getStoryStateText('uuid-1')).toBe('');
        expect(getStoryStateText('uuid-2')).toBe(NOTE_B);
    });
    it('persists through the settings store and saves', () => {
        setStoryStateText('uuid-1', NOTE_A);
        expect(mocks.extensionSettings.vecttauri.story_state_by_chat['uuid-1'].text).toBe(NOTE_A);
        expect(mocks.saveSettingsDebounced).toHaveBeenCalled();
    });
    it('caps hand-edited text on a line boundary', () => {
        const stored = setStoryStateText('uuid-1', 'aaaa\nbbbb\ncccc', 10);
        expect(stored).toBe('aaaa\nbbbb');
    });
    it('undo with nothing to undo is a no-op', () => {
        expect(undoStoryState('uuid-1')).toBe(false);
    });
});

describe('updateStoryState', () => {
    it('writes the new note, keeps one previous version, builds the prompt from state + messages', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        reply(NOTE_B);
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(6), boundary: 6, settings: BASE_SETTINGS() });
        expect(res.status).toBe('updated');
        const rec = getStoryStateRecord('uuid-1');
        expect(rec.text).toBe(NOTE_B);
        expect(rec.prev).toBe(NOTE_A);
        expect(rec.coveredIdx).toBe(6);
        expect(rec.pendingWindows).toBe(0);

        const call = mocks.postChatCompletion.mock.calls[0][0];
        expect(call.contextLabel).toBe('Story State');
        expect(call.provider).toBe('openrouter');
        expect(call.maxTokens).toBe(700);
        const prompt = call.messages[0].content;
        expect(prompt).toContain(NOTE_A);
        expect(prompt).toContain('User: message 0');
        expect(prompt).toContain('English');
    });

    it('is incremental: the second update only feeds messages after the cursor', async () => {
        reply(NOTE_A);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(6), boundary: 6, settings: BASE_SETTINGS() });
        reply(NOTE_B);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(10), boundary: 10, settings: BASE_SETTINGS() });
        const prompt = mocks.postChatCompletion.mock.calls[1][0].messages[0].content;
        expect(prompt).toContain('message 6');
        expect(prompt).toContain('message 9');
        expect(prompt).not.toContain('message 5');
    });

    it('uses the story language of the tokenizer mode', async () => {
        reply(NOTE_A);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(2), settings: BASE_SETTINGS({ cjk_tokenizer_mode: 'korean' }) });
        expect(mocks.postChatCompletion.mock.calls[0][0].messages[0].content).toContain('Korean');
    });

    it('routes custom/vLLM providers with the base URL', async () => {
        reply(NOTE_A);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(2), settings: BASE_SETTINGS({ chat_provider: 'vllm', chat_vllm_url: 'http://x:8000' }) });
        expect(mocks.postChatCompletion.mock.calls[0][0]).toMatchObject({ provider: 'vllm', vllmUrl: 'http://x:8000' });
    });

    it.each([
        ['an empty reply', ''],
        ['a garbled reply', 'I cannot do that.'],
        ['a JSON reply', '{"a":1}'],
    ])('keeps the old note on %s', async (_label, content) => {
        setStoryStateText('uuid-1', NOTE_A);
        reply(content);
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(res.status).toBe('failed');
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
        expect(getStoryStateRecord('uuid-1').prev).toBe(null);
    });

    it('rejects a suspiciously short reply when the previous note was long', async () => {
        const longNote = 'SITUATION\n' + Array.from({ length: 30 }, (_, i) => `- fact number ${i} about the story`).join('\n');
        setStoryStateText('uuid-1', longNote);
        reply('SITUATION\n- ok');
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(res).toMatchObject({ status: 'failed', reason: 'suspect' });
        expect(getStoryStateText('uuid-1')).toBe(longNote);
    });

    it.each(['connection', 'http', 'upstream_error', 'empty', 'auth'])('keeps the old note on LlmCallError kind=%s', async (kind) => {
        setStoryStateText('uuid-1', NOTE_A);
        mocks.postChatCompletion.mockRejectedValueOnce(new mocks.LlmCallError('boom', { kind }));
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(res).toMatchObject({ status: 'failed', reason: kind });
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
        expect(mocks.notifyInvalidModel).not.toHaveBeenCalled();
    });

    it('notifies through the shared notifier only for model-config errors', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        mocks.postChatCompletion.mockRejectedValueOnce(new mocks.LlmCallError('model gone', { kind: 'model_config' }));
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(res).toMatchObject({ status: 'failed', reason: 'model_config' });
        expect(mocks.notifyInvalidModel).toHaveBeenCalledWith('model gone');
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
    });

    it('reports a missing model without calling the LLM', async () => {
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS({ chat_model: '' }) });
        expect(res).toMatchObject({ status: 'failed', reason: 'config' });
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
    });

    it('never throws on an unexpected error', async () => {
        mocks.postChatCompletion.mockRejectedValueOnce(new TypeError('weird'));
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(res.status).toBe('failed');
    });

    it('does nothing while locked, even for a manual update', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS({ story_state_locked: true }) });
        expect(res).toMatchObject({ status: 'skipped', reason: 'locked' });
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
    });

    it('skips when there are no new messages', async () => {
        reply(NOTE_A);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), boundary: 4, settings: BASE_SETTINGS() });
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), boundary: 4, settings: BASE_SETTINGS() });
        expect(res).toMatchObject({ status: 'skipped', reason: 'no_new_messages' });
        expect(mocks.postChatCompletion).toHaveBeenCalledTimes(1);
    });

    it('discards the result when the user edited the note during the call', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        mocks.postChatCompletion.mockImplementationOnce(async () => {
            setStoryStateText('uuid-1', 'SITUATION\n- hand edit');
            return { content: NOTE_B };
        });
        const res = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(res).toMatchObject({ status: 'skipped', reason: 'edited_during_update' });
        expect(getStoryStateText('uuid-1')).toBe('SITUATION\n- hand edit');
    });

    it('runs one update per chat at a time but chats do not block each other', async () => {
        let release;
        mocks.postChatCompletion.mockImplementationOnce(() => new Promise((r) => { release = () => r({ content: NOTE_A }); }));
        const first = updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        const dup = await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(dup).toMatchObject({ status: 'skipped', reason: 'busy' });
        reply(NOTE_B);
        const other = await updateStoryState({ uuid: 'uuid-2', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(other.status).toBe('updated');
        release();
        expect((await first).status).toBe('updated');
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
        expect(getStoryStateText('uuid-2')).toBe(NOTE_B);
    });
});

describe('undo', () => {
    it('restores the version before the last update, once', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        reply(NOTE_B);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), settings: BASE_SETTINGS() });
        expect(undoStoryState('uuid-1')).toBe(true);
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
        expect(undoStoryState('uuid-1')).toBe(false);
    });
    it('a hand edit after an auto-update becomes the undo target of the next update', async () => {
        reply(NOTE_A);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(4), boundary: 4, settings: BASE_SETTINGS() });
        setStoryStateText('uuid-1', NOTE_B);
        reply(NOTE_A);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(8), boundary: 8, settings: BASE_SETTINGS() });
        expect(mocks.postChatCompletion.mock.calls[1][0].messages[0].content).toContain('Find the key.');
        expect(undoStoryState('uuid-1')).toBe(true);
        expect(getStoryStateText('uuid-1')).toBe(NOTE_B);
    });
});

describe('onExtractionRun (auto-update hook)', () => {
    const run = (windowsProcessed, over = {}, settings = BASE_SETTINGS()) =>
        onExtractionRun({ uuid: 'uuid-1', messages: msgs(10), boundary: 10, windowsProcessed, settings, ...over });

    it('does nothing when disabled or when no window was processed', async () => {
        expect((await run(1, {}, BASE_SETTINGS({ story_state_enabled: false }))).reason).toBe('off');
        expect((await run(0)).reason).toBe('off');
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
        expect(mocks.extensionSettings.vecttauri.story_state_by_chat).toBeUndefined();
    });

    it('does nothing when the master switch is off', async () => {
        mocks.extensionSettings.vecttauri.enabled = false;
        expect((await run(5, {}, BASE_SETTINGS({ enabled: false }))).reason).toBe('off');
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
    });

    it('counts windows across runs and updates every N', async () => {
        expect((await run(1)).reason).toBe('not_due');
        expect((await run(1)).reason).toBe('not_due');
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
        reply(NOTE_A);
        expect((await run(1)).status).toBe('updated');
        expect(getStoryStateRecord('uuid-1').pendingWindows).toBe(0);
        expect((await run(1)).reason).toBe('not_due');
    });

    it('honours story_state_update_every', async () => {
        reply(NOTE_A);
        expect((await run(1, {}, BASE_SETTINGS({ story_state_update_every: 1 }))).status).toBe('updated');
    });

    it('retries on the next run after a failed update', async () => {
        mocks.postChatCompletion.mockRejectedValueOnce(new mocks.LlmCallError('x', { kind: 'http' }));
        expect((await run(3)).status).toBe('failed');
        expect(getStoryStateRecord('uuid-1').pendingWindows).toBe(3);
        reply(NOTE_A);
        expect((await run(1)).status).toBe('updated');
    });

    it('never auto-updates a locked note', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        const res = await run(5, {}, BASE_SETTINGS({ story_state_locked: true }));
        expect(res.reason).toBe('locked');
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
    });

    it('only folds settled messages (up to the boundary) into the note', async () => {
        reply(NOTE_A);
        await run(3, { messages: msgs(10), boundary: 8 });
        const prompt = mocks.postChatCompletion.mock.calls[0][0].messages[0].content;
        expect(prompt).toContain('message 7');
        expect(prompt).not.toContain('message 8');
        expect(getStoryStateRecord('uuid-1').coveredIdx).toBe(8);
    });
});

describe('formatMessagesForStoryState', () => {
    it('strips reasoning, caps long messages and keeps chronological order', () => {
        const out = formatMessagesForStoryState([
            { name: 'A', mes: '<think>secret</think>first' },
            { name: 'B', mes: 'x'.repeat(5000) },
        ]);
        expect(out).not.toContain('secret');
        expect(out.indexOf('A: first')).toBeLessThan(out.indexOf('B: x'));
        expect(out.length).toBeLessThan(1500);
    });
});

describe('runStoryStateInjection', () => {
    const lastCall = () => mocks.setExtensionPrompt.mock.calls.at(-1);

    it('injects the labelled block at the configured position/depth', () => {
        setStoryStateText('uuid-1', NOTE_A);
        const res = runStoryStateInjection(BASE_SETTINGS());
        expect(res.injected).toBe(true);
        const [tag, value, position, depth, scan] = lastCall();
        expect(tag).toBe(STORY_STATE_PROMPT_TAG);
        expect(value).toBe(buildStoryStateBlock(NOTE_A));
        expect([position, depth, scan]).toEqual([1, 4, false]);
    });

    it('is independent of EventBase: needs no retrieval, just the note', () => {
        setStoryStateText('uuid-1', NOTE_A);
        runStoryStateInjection(BASE_SETTINGS());
        expect(lastCall()[1]).toContain('Current story state — treat as true');
    });

    it('clears the slot for an empty note', () => {
        expect(runStoryStateInjection(BASE_SETTINGS()).injected).toBe(false);
        expect(lastCall()[1]).toBe('');
    });

    it('clears the slot when the feature is disabled, even with a stored note', () => {
        setStoryStateText('uuid-1', NOTE_A);
        runStoryStateInjection(BASE_SETTINGS({ story_state_enabled: false }));
        expect(lastCall()[1]).toBe('');
    });

    it('clears the slot when the master switch is off', () => {
        setStoryStateText('uuid-1', NOTE_A);
        runStoryStateInjection(BASE_SETTINGS({ enabled: false }));
        expect(lastCall()[1]).toBe('');
    });

    it('injects only the current chat\'s note', () => {
        setStoryStateText('uuid-1', NOTE_A);
        setStoryStateText('uuid-2', NOTE_B);
        mocks.chatUUID.value = 'uuid-2';
        runStoryStateInjection(BASE_SETTINGS());
        expect(lastCall()[1]).toContain('Find the key.');
        expect(lastCall()[1]).not.toContain('tavern');
    });

    it('applies the character cap at injection time', () => {
        const big = 'SITUATION\n' + Array.from({ length: 200 }, (_, i) => `- fact ${i}`).join('\n');
        mocks.extensionSettings.vecttauri.story_state_by_chat = { 'uuid-1': { text: big } };
        runStoryStateInjection(BASE_SETTINGS({ story_state_max_chars: 300 }));
        expect(lastCall()[1].length).toBeLessThan(300 + 200);
    });

    it('never throws', () => {
        mocks.setExtensionPrompt.mockImplementationOnce(() => { throw new Error('host broke'); });
        expect(() => runStoryStateInjection(BASE_SETTINGS())).not.toThrow();
    });
});


describe('rebuildStoryState (whole-chat backfill)', () => {
    // 70 short messages → 3 steps (30 + 30 + 10), because a step reads at most 30 messages.
    const settings = () => BASE_SETTINGS();

    it('takeBackfillChunk walks FORWARD, so the oldest messages are never dropped', () => {
        const { text, next } = takeBackfillChunk(msgs(70), 0, 70);
        expect(next).toBe(30);
        expect(text).toContain('message 0');
        expect(text).toContain('message 29');
        expect(text).not.toContain('message 30');
    });

    it('estimateRebuildCalls matches the chunking, and skips unreadable messages', () => {
        expect(estimateRebuildCalls(msgs(70))).toBe(3);
        expect(estimateRebuildCalls(msgs(30))).toBe(1);
        expect(estimateRebuildCalls([])).toBe(0);
        expect(estimateRebuildCalls([{ mes: '' }, { mes: '   ' }])).toBe(0);
    });

    it('reads the chat from the first message and feeds the working note back each step', async () => {
        reply(NOTE_A); reply(NOTE_B); reply(NOTE_B);
        const progress = [];
        const res = await rebuildStoryState({
            uuid: 'uuid-1', messages: msgs(70), settings: settings(), onProgress: (d, t) => progress.push([d, t]),
        });
        expect(res.status).toBe('updated');
        expect(mocks.postChatCompletion).toHaveBeenCalledTimes(3);
        const prompts = mocks.postChatCompletion.mock.calls.map(c => c[0].messages[0].content);
        expect(prompts[0]).toContain('message 0');                 // the premise end of the chat IS read
        expect(prompts[0]).not.toContain('message 30');
        expect(prompts[1]).toContain(NOTE_A);                      // step 2 starts from step 1's note
        expect(prompts[1]).toContain('message 30');
        expect(prompts[2]).toContain('message 69');
        expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
        const rec = getStoryStateRecord('uuid-1');
        expect(rec.text).toBe(NOTE_B);
        expect(rec.coveredIdx).toBe(70);
    });

    it('keeps the previous note as the undo target and starts the rebuild from an EMPTY note', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        reply(NOTE_B);
        await rebuildStoryState({ uuid: 'uuid-1', messages: msgs(10), settings: settings() });
        expect(mocks.postChatCompletion.mock.calls[0][0].messages[0].content).not.toContain(NOTE_A);
        const rec = getStoryStateRecord('uuid-1');
        expect(rec.prev).toBe(NOTE_A);
        expect(undoStoryState('uuid-1')).toBe(true);
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
    });

    it('is all-or-nothing: a failed step leaves the existing note untouched', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        reply(NOTE_B);                                              // step 1 ok
        mocks.postChatCompletion.mockRejectedValueOnce(new mocks.LlmCallError('boom', { kind: 'http' }));
        const res = await rebuildStoryState({ uuid: 'uuid-1', messages: msgs(70), settings: settings() });
        expect(res.status).toBe('failed');
        expect(res.message).toMatch(/step 2\/3/);
        expect(res.message).toMatch(/not changed/);
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
    });

    it('rejects an unusable reply mid-way without touching the note', async () => {
        setStoryStateText('uuid-1', NOTE_A);
        reply('no headers here at all');
        const res = await rebuildStoryState({ uuid: 'uuid-1', messages: msgs(10), settings: settings() });
        expect(res.status).toBe('failed');
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
    });

    it('respects the lock and the empty chat, with no LLM call', async () => {
        const locked = await rebuildStoryState({ uuid: 'uuid-1', messages: msgs(10), settings: BASE_SETTINGS({ story_state_locked: true }) });
        expect(locked).toMatchObject({ status: 'skipped', reason: 'locked' });
        const empty = await rebuildStoryState({ uuid: 'uuid-1', messages: [], settings: settings() });
        expect(empty).toMatchObject({ status: 'skipped', reason: 'no_new_messages' });
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
    });

    it('does not run twice at once for one chat', async () => {
        let release;
        mocks.postChatCompletion.mockImplementationOnce(() => new Promise((r) => { release = () => r({ content: NOTE_A }); }));
        const first = rebuildStoryState({ uuid: 'uuid-1', messages: msgs(10), settings: settings() });
        const second = await rebuildStoryState({ uuid: 'uuid-1', messages: msgs(10), settings: settings() });
        expect(second).toMatchObject({ status: 'skipped', reason: 'busy' });
        await new Promise(r => setTimeout(r, 0));
        release();
        expect((await first).status).toBe('updated');
    });

    it('later incremental updates continue from the end of the rebuilt chat', async () => {
        reply(NOTE_A);
        await rebuildStoryState({ uuid: 'uuid-1', messages: msgs(10), settings: settings() });
        reply(NOTE_B);
        await updateStoryState({ uuid: 'uuid-1', messages: msgs(14), boundary: 14, settings: settings() });
        const prompt = mocks.postChatCompletion.mock.calls[1][0].messages[0].content;
        expect(prompt).toContain('message 10');
        expect(prompt).not.toContain('message 9');
    });
});


describe('onFullIngestionRun (after a manual / backfill ingestion)', () => {
    it('builds the note from the whole chat when the chat has none', async () => {
        reply(NOTE_A);
        const res = await onFullIngestionRun({ uuid: 'uuid-1', messages: msgs(10), settings: BASE_SETTINGS() });
        expect(res.status).toBe('updated');
        expect(getStoryStateText('uuid-1')).toBe(NOTE_A);
        expect(mocks.postChatCompletion.mock.calls[0][0].messages[0].content).toContain('message 0');
    });

    it('never overwrites an existing note (hand-written or earlier)', async () => {
        setStoryStateText('uuid-1', NOTE_B);
        const res = await onFullIngestionRun({ uuid: 'uuid-1', messages: msgs(10), settings: BASE_SETTINGS() });
        expect(res).toMatchObject({ status: 'skipped', reason: 'has_note' });
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
        expect(getStoryStateText('uuid-1')).toBe(NOTE_B);
    });

    it('does nothing when the feature is off or the note is locked', async () => {
        expect((await onFullIngestionRun({ uuid: 'uuid-1', messages: msgs(10), settings: BASE_SETTINGS({ story_state_enabled: false }) })).reason).toBe('off');
        expect((await onFullIngestionRun({ uuid: 'uuid-1', messages: msgs(10), settings: BASE_SETTINGS({ story_state_locked: true }) })).reason).toBe('locked');
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
    });

    it('ignores empty messages and survives a failing LLM (returns failed, never throws)', async () => {
        mocks.postChatCompletion.mockRejectedValueOnce(new mocks.LlmCallError('boom', { kind: 'http' }));
        const res = await onFullIngestionRun({
            uuid: 'uuid-1', messages: [...msgs(4), { mes: '' }, { mes: '   ' }], settings: BASE_SETTINGS(),
        });
        expect(res.status).toBe('failed');
        expect(getStoryStateText('uuid-1')).toBe('');
    });

    it('an empty chat is a no-op, not an error', async () => {
        const res = await onFullIngestionRun({ uuid: 'uuid-1', messages: [], settings: BASE_SETTINGS() });
        expect(res.status).toBe('skipped');
        expect(mocks.postChatCompletion).not.toHaveBeenCalled();
    });
});
