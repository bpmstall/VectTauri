/**
 * ============================================================================
 * STORY STATE
 * ============================================================================
 * One compact, always-injected, auto-updating "current situation" note per chat.
 *
 * Why: EventBase retrieval is similarity-based, so it cannot guarantee the
 * CURRENT situation is in the prompt ("the player only arrived on Earth this
 * week" loses to older, similar-looking events). A note that is injected on
 * every turn can. Core facts pin individual events; this tracks the live state.
 *
 * UPDATE: incremental. After the EventBase auto-sync extraction finishes a run
 * (hook: runEventBaseIngestion, see onExtractionRun), every
 * `story_state_update_every` extraction windows the LLM gets (previous note) +
 * (messages not yet covered) and returns the NEW full note. A failed, empty,
 * garbled or suspiciously short reply NEVER overwrites the stored note.
 *
 * STORAGE: extension_settings.vecttauri.story_state_by_chat[chatUUID] — the same
 * mechanism as the other per-chat maps (start marker, window size, tip). One
 * previous version is kept so the last auto-update can be undone. The map is
 * created lazily (it is deliberately NOT in defaultSettings, so the UI's
 * settings copy can never overwrite it with a stale reference).
 *
 * INJECTION: its own extension-prompt tag (STORY_STATE_PROMPT_TAG), set from the
 * generation interceptor independently of EventBase retrieval.
 * ============================================================================
 */

import { setExtensionPrompt, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getChatUUID } from './collection-ids.js';
import { STORY_STATE_PROMPT_TAG } from './constants.js';
import { isVectTauriEnabled } from './feature-gate.js';
import { getLlmOpenRouterApiKey, getLlmCustomApiKey } from './api-keys.js';
import { postChatCompletion, resolveModelParameterStyle, resolveLlmCredentials, LlmCallError } from './llm-provider-call.js';
import { isInvalidModelConfigError, notifyInvalidModel } from './model-config-notifier.js';
import { resolveLlmEffectiveSettings } from '../utils/llm-config-store.js';
import { buildStoryStateUpdatePrompt, STORY_STATE_SECTIONS } from './prompts-i18n.js';
import { stripReasoningBlocks, cleanText } from './text-cleaning.js';
import StringUtils from '../utils/string-utils.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Constants / config
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_EVERY = 3;
const DEFAULT_MAX_TOKENS = 700;
const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60000;

// Suspect-reply guard: a new note under 30% of a previous note longer than 300
// chars looks like the model dropped the state wholesale — keep the old one.
const SUSPECT_MIN_PREVIOUS_CHARS = 300;
const SUSPECT_MIN_RATIO = 0.3;

// How much chat one update may read. Per-message and total caps bound the prompt;
// the newest messages win when the cap bites.
const FEED_MAX_MESSAGES = 30;
const FEED_MESSAGE_CHAR_CAP = 1200;
const FEED_TOTAL_CHAR_CAP = 14000;

const _clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};

/**
 * Resolve the story-state settings with bounds. Missing values fall back to the
 * documented defaults, so a settings object from before this feature works.
 * @param {object} [settings]
 * @returns {{enabled: boolean, locked: boolean, updateEvery: number, maxTokens: number, maxChars: number}}
 */
export function resolveStoryStateConfig(settings) {
    return {
        enabled: settings?.story_state_enabled === true,
        locked: settings?.story_state_locked === true,
        updateEvery: _clamp(settings?.story_state_update_every, 1, 20, DEFAULT_UPDATE_EVERY),
        maxTokens: _clamp(settings?.story_state_max_tokens, 100, 4000, DEFAULT_MAX_TOKENS),
        maxChars: _clamp(settings?.story_state_max_chars, 300, 8000, DEFAULT_MAX_CHARS),
    };
}

// ---------------------------------------------------------------------------
// Parsing / truncation / guards (pure)
// ---------------------------------------------------------------------------

/**
 * Cut `text` to at most `maxChars`, on a line boundary — never mid-line.
 * Returns '' when not even the first line fits.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateAtLine(text, maxChars) {
    const s = String(text ?? '').trim();
    if (s.length <= maxChars) return s;
    const kept = [];
    let used = 0;
    for (const line of s.split('\n')) {
        const cost = line.length + (kept.length ? 1 : 0);
        if (used + cost > maxChars) break;
        kept.push(line);
        used += cost;
    }
    return kept.join('\n').trimEnd();
}

const _HEADER_RE = new RegExp(
    `^\\s*(?:#{1,6}\\s*|\\*{1,2}|\\[)?\\s*(${STORY_STATE_SECTIONS.map(h => h.replace(/ /g, '\\s+')).join('|')})\\s*(?:\\]|\\*{1,2})?\\s*:?\\s*$`,
    'i',
);

/**
 * Validate and clean a raw LLM reply into a note. Strips reasoning blocks and
 * code fences, drops any preamble before the first section header, rejects JSON
 * and header-less text, then truncates on a line boundary.
 *
 * @param {string} raw
 * @param {{maxChars?: number}} [opts]
 * @returns {{ok: true, text: string} | {ok: false, reason: 'empty'|'garbled'|'too_long'}}
 */
export function parseStoryStateReply(raw, { maxChars = DEFAULT_MAX_CHARS } = {}) {
    let text = stripReasoningBlocks(String(raw ?? ''));
    text = String(text ?? '')
        .replace(/^\s*```[a-z]*\s*$/gim, '')
        .replace(/\r\n?/g, '\n')
        .trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (/^[{[]/.test(text)) return { ok: false, reason: 'garbled' };

    const lines = text.split('\n');
    const firstHeader = lines.findIndex(line => _HEADER_RE.test(line));
    if (firstHeader === -1) return { ok: false, reason: 'garbled' };

    const cleaned = lines.slice(firstHeader).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const truncated = truncateAtLine(cleaned, maxChars);
    if (!truncated) return { ok: false, reason: 'too_long' };
    return { ok: true, text: truncated };
}

/**
 * True when `next` looks like the model dropped the previous state wholesale.
 * @param {string} previous
 * @param {string} next
 * @returns {boolean}
 */
export function isSuspectShrink(previous, next) {
    const prevLen = String(previous ?? '').trim().length;
    if (prevLen <= SUSPECT_MIN_PREVIOUS_CHARS) return false;
    return String(next ?? '').trim().length < prevLen * SUSPECT_MIN_RATIO;
}

/**
 * Wrap a note in its own clearly labelled injection block.
 * @param {string} text
 * @returns {string} '' for an empty note
 */
export function buildStoryStateBlock(text) {
    const body = String(text ?? '').trim();
    if (!body) return '';
    return `<VectTauriStoryState>\nCurrent story state — treat as true. If older memories conflict with it, this is the latest.\n${body}\n</VectTauriStoryState>`;
}

// ---------------------------------------------------------------------------
// Storage (per chat UUID)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StoryStateRecord
 * @property {string} text            current note ('' = none)
 * @property {string|null} prev       previous version, for undo
 * @property {number} updatedAt       ms epoch of the last change (0 = never)
 * @property {number|null} coveredIdx messages (filtered chat) already folded into the note
 * @property {number} pendingWindows  extraction windows since the last update
 */

const _emptyRecord = () => ({ text: '', prev: null, updatedAt: 0, coveredIdx: null, pendingWindows: 0 });

function _map(create) {
    const store = extension_settings?.vecttauri;
    if (!store) return null;
    if (!store.story_state_by_chat || typeof store.story_state_by_chat !== 'object') {
        if (!create) return null;
        store.story_state_by_chat = {};
    }
    return store.story_state_by_chat;
}

/**
 * @param {string} uuid
 * @returns {StoryStateRecord} a copy; mutating it does not touch the store
 */
export function getStoryStateRecord(uuid) {
    const raw = uuid ? _map(false)?.[uuid] : null;
    if (!raw || typeof raw !== 'object') return _emptyRecord();
    return {
        text: typeof raw.text === 'string' ? raw.text : '',
        prev: typeof raw.prev === 'string' ? raw.prev : null,
        updatedAt: Number(raw.updatedAt) || 0,
        coveredIdx: Number.isFinite(raw.coveredIdx) ? raw.coveredIdx : null,
        pendingWindows: Number(raw.pendingWindows) || 0,
    };
}

function _saveRecord(uuid, record) {
    const map = _map(true);
    if (!map || !uuid) return false;
    map[uuid] = record;
    saveSettingsDebounced();
    return true;
}

/** @param {string} uuid @returns {string} the current note ('' when none) */
export function getStoryStateText(uuid) {
    return getStoryStateRecord(uuid).text;
}

/**
 * Save a hand-edited note. It becomes the base of the next incremental update.
 * Capped like auto-updates; the previous text is kept for undo.
 * @param {string} uuid
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string} the stored (possibly truncated) text
 */
export function setStoryStateText(uuid, text, maxChars = DEFAULT_MAX_CHARS) {
    if (!uuid) return '';
    const rec = getStoryStateRecord(uuid);
    const next = truncateAtLine(String(text ?? '').replace(/\r\n?/g, '\n'), maxChars);
    if (next === rec.text) return next;
    _saveRecord(uuid, { ...rec, prev: rec.text || rec.prev, text: next, updatedAt: Date.now() });
    return next;
}

/** Clear the note (and its undo copy). Keeps the covered-message cursor. */
export function clearStoryState(uuid) {
    if (!uuid) return;
    const rec = getStoryStateRecord(uuid);
    _saveRecord(uuid, { ...rec, text: '', prev: null, updatedAt: Date.now(), pendingWindows: 0 });
}

/**
 * Restore the version before the last update.
 * @param {string} uuid
 * @returns {boolean} false when there is nothing to undo
 */
export function undoStoryState(uuid) {
    const rec = getStoryStateRecord(uuid);
    if (rec.prev === null) return false;
    _saveRecord(uuid, { ...rec, text: rec.prev, prev: null, updatedAt: Date.now() });
    return true;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/** Config problem found before any request (missing key / url / model). */
class StoryStateConfigError extends Error {
    constructor(message) { super(message); this.name = 'StoryStateConfigError'; }
}

async function _callLlm(prompt, settings, maxTokens) {
    const provider = (settings.chat_provider || 'openrouter').toLowerCase();
    const isCustom = provider === 'vllm' || provider === 'custom';

    const model = (settings.chat_model || '').trim();
    if (!model) throw new StoryStateConfigError('Story State: no model configured. Set the Summarization Model in Core → LLM Summarization settings.');

    let vllmUrl = '';
    if (isCustom) {
        vllmUrl = (settings.chat_vllm_url || '').trim();
        if (!vllmUrl) throw new StoryStateConfigError('Story State: Base URL not configured. Set it in Core → LLM Summarization settings.');
        if (!getLlmCustomApiKey(settings)) throw new StoryStateConfigError('Story State: API key not configured. Enter it in Core → LLM Summarization settings.');
    } else if (!getLlmOpenRouterApiKey(settings)) {
        throw new StoryStateConfigError('Story State: OpenRouter API key not found. Add it in EventBase settings.');
    }

    const { content } = await postChatCompletion({
        messages: [{ role: 'user', content: prompt }],
        model,
        provider: isCustom ? 'vllm' : 'openrouter',
        ...(isCustom ? { vllmUrl } : {}),
        maxTokens,
        temperature: settings.eventbase_temperature ?? DEFAULT_TEMPERATURE,
        timeoutMs: settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS,
        contextLabel: 'Story State',
        backupModel: settings.chat_model_backup || '',
        ...resolveModelParameterStyle(settings),
        ...resolveLlmCredentials(settings),
    });
    return content;
}

// ---------------------------------------------------------------------------
// Update flow
// ---------------------------------------------------------------------------

/**
 * Format the not-yet-covered messages for the prompt: newest-first budget,
 * chronological output, reasoning stripped, each message capped.
 * @param {object[]} messages
 * @returns {string}
 */
export function formatMessagesForStoryState(messages) {
    const picked = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0 && picked.length < FEED_MAX_MESSAGES; i--) {
        const m = messages[i];
        const speaker = m?.name || (m?.is_user ? 'User' : 'Assistant');
        let text = String(m?.mes ?? '');
        text = stripReasoningBlocks(text);
        text = String(cleanText(text) ?? '').trim();
        if (!text) continue;
        const line = `${speaker}: ${StringUtils.truncateCodePoints(text, FEED_MESSAGE_CHAR_CAP)}`;
        if (picked.length && total + line.length > FEED_TOTAL_CHAR_CAP) break;
        picked.push(line);
        total += line.length;
    }
    return picked.reverse().join('\n\n');
}

const _inFlight = new Map(); // uuid → Promise (one update per chat at a time)

/**
 * @typedef {object} StoryStateResult
 * @property {'updated'|'skipped'|'failed'} status
 * @property {string} reason   machine-readable cause
 * @property {string} message  short human sentence (shown by "Update now")
 */

/**
 * Run one incremental update. Never throws; never overwrites the stored note on
 * any failure.
 *
 * @param {object} params
 * @param {string} params.uuid
 * @param {object[]} params.messages  filtered chat messages (non-empty `mes`)
 * @param {number} [params.boundary]  messages [0, boundary) may be folded in (default: all)
 * @param {object} params.settings
 * @returns {Promise<StoryStateResult>}
 */
export function updateStoryState(params) {
    const uuid = params?.uuid;
    if (!uuid) return Promise.resolve({ status: 'skipped', reason: 'no_chat', message: 'No chat is open.' });
    if (_inFlight.has(uuid)) return Promise.resolve({ status: 'skipped', reason: 'busy', message: 'An update is already running.' });
    const run = _runUpdate(params)
        .catch((err) => {
            log.warn('[StoryState] update crashed (state untouched):', err);
            return { status: 'failed', reason: 'error', message: `Story State update failed: ${err?.message || err}` };
        })
        .finally(() => _inFlight.delete(uuid));
    _inFlight.set(uuid, run);
    return run;
}

async function _runUpdate({ uuid, messages, boundary, settings: rawSettings }) {
    const settings = resolveLlmEffectiveSettings(rawSettings);
    const cfg = resolveStoryStateConfig(rawSettings);
    const list = Array.isArray(messages) ? messages : [];
    const end = Math.max(0, Math.min(list.length, Number.isFinite(boundary) ? boundary : list.length));

    const before = getStoryStateRecord(uuid);
    if (cfg.locked) return { status: 'skipped', reason: 'locked', message: 'Story State is locked — unlock it to allow updates.' };

    // Cursor: where the last update stopped. A shrunken chat (deleted messages) or a
    // first run starts from the newest FEED_MAX_MESSAGES instead.
    const start = (before.coveredIdx !== null && before.coveredIdx <= end)
        ? before.coveredIdx
        : Math.max(0, end - FEED_MAX_MESSAGES);
    const fresh = list.slice(start, end);
    const formatted = formatMessagesForStoryState(fresh);
    if (!formatted) return { status: 'skipped', reason: 'no_new_messages', message: 'No new messages since the last update.' };

    const prompt = buildStoryStateUpdatePrompt({
        previous: before.text,
        messages: formatted,
        maxChars: cfg.maxChars,
        mode: settings.cjk_tokenizer_mode || 'intl',
    });

    let reply;
    try {
        reply = await _callLlm(prompt, settings, cfg.maxTokens);
    } catch (err) {
        return _describeCallFailure(err);
    }

    const parsed = parseStoryStateReply(reply, { maxChars: cfg.maxChars });
    if (!parsed.ok) {
        log.warn(`[StoryState] reply rejected (${parsed.reason}) — keeping the previous state. Reply start: ${String(reply ?? '').slice(0, 200)}`);
        return { status: 'failed', reason: parsed.reason, message: `The model's reply was unusable (${parsed.reason}) — the previous state was kept.` };
    }
    if (isSuspectShrink(before.text, parsed.text)) {
        log.warn(`[StoryState] reply rejected (suspect shrink ${parsed.text.length} vs ${before.text.length} chars) — keeping the previous state`);
        return { status: 'failed', reason: 'suspect', message: 'The new state was much shorter than the old one — treated as unreliable, the previous state was kept.' };
    }

    // The LLM call can take many seconds; honour a lock or hand edit made meanwhile.
    const now = getStoryStateRecord(uuid);
    if (resolveStoryStateConfig(extension_settings?.vecttauri ?? rawSettings).locked) {
        return { status: 'skipped', reason: 'locked', message: 'Story State was locked during the update — result discarded.' };
    }
    if (now.text !== before.text) {
        return { status: 'skipped', reason: 'edited_during_update', message: 'The note was edited during the update — result discarded.' };
    }

    _saveRecord(uuid, {
        text: parsed.text,
        prev: before.text || null,
        updatedAt: Date.now(),
        coveredIdx: end,
        pendingWindows: 0,
    });
    log.lifecycle(`[StoryState] updated (${before.text.length} → ${parsed.text.length} chars, covered ${start}-${end})`);
    // Tell the UI (EventBase tab textarea) the note changed; cheap, listeners just re-read.
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('vecttauri:story-state-updated', { detail: { uuid } }));
    }
    return { status: 'updated', reason: 'ok', message: `Story State updated (${parsed.text.length} characters).` };
}

/**
 * Map a failed call to a result. Only model-config errors raise a toast here, via
 * the shared de-duped notifier; connection and upstream-rejection toasts are raised
 * by postChatCompletion itself. Auth/config problems also break EventBase
 * extraction (same credentials), which already surfaces them — here they are
 * logged and returned for "Update now" to display.
 * @param {unknown} err
 * @returns {StoryStateResult}
 */
function _describeCallFailure(err) {
    if (isInvalidModelConfigError(err) || (err instanceof LlmCallError && err.kind === 'model_config')) {
        notifyInvalidModel(err.message);
        return { status: 'failed', reason: 'model_config', message: err.message };
    }
    if (err instanceof LlmCallError) {
        log.warn(`[StoryState] LLM call failed (${err.kind}): ${err.message}`);
        return { status: 'failed', reason: err.kind, message: `Story State update failed (${err.kind}): ${err.message}` };
    }
    if (err instanceof StoryStateConfigError) {
        log.warn(`[StoryState] ${err.message}`);
        return { status: 'failed', reason: 'config', message: err.message };
    }
    throw err; // unknown → caught by updateStoryState's crash handler
}

/**
 * Auto-update hook, called at the end of an EventBase auto-sync ingestion run.
 * Counts extraction windows and updates every `story_state_update_every`.
 * Cheap and safe to call unconditionally: exits when the feature is off, the
 * master switch is off, or the note is locked. Never throws.
 *
 * @param {object} params
 * @param {string} params.uuid
 * @param {object[]} params.messages     filtered chat messages (same list the run used)
 * @param {number} params.boundary       commit boundary: messages [0, boundary) are settled
 * @param {number} params.windowsProcessed extraction windows this run completed
 * @param {object} params.settings
 * @returns {Promise<StoryStateResult>}
 */
export async function onExtractionRun({ uuid, messages, boundary, windowsProcessed, settings }) {
    try {
        const cfg = resolveStoryStateConfig(settings);
        if (!cfg.enabled || !isVectTauriEnabled(settings) || !uuid || !(windowsProcessed > 0)) {
            return { status: 'skipped', reason: 'off', message: '' };
        }
        if (cfg.locked) return { status: 'skipped', reason: 'locked', message: '' };

        const rec = getStoryStateRecord(uuid);
        const pending = rec.pendingWindows + windowsProcessed;
        if (pending < cfg.updateEvery) {
            _saveRecord(uuid, { ...rec, pendingWindows: pending });
            return { status: 'skipped', reason: 'not_due', message: '' };
        }
        _saveRecord(uuid, { ...rec, pendingWindows: pending });
        return await updateStoryState({ uuid, messages, boundary, settings });
    } catch (err) {
        log.warn('[StoryState] auto-update hook failed (non-fatal):', err);
        return { status: 'failed', reason: 'error', message: String(err?.message || err) };
    }
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Inject (or clear) the story-state block. Synchronous and self-clearing: empty
 * note, feature off, master switch off or no chat all leave the slot empty.
 * Never throws — a failure here must not break generation.
 *
 * @param {object} settings - extension_settings.vecttauri
 * @returns {{injected: boolean, chars: number}}
 */
export function runStoryStateInjection(settings) {
    try {
        const cfg = resolveStoryStateConfig(settings);
        const uuid = (cfg.enabled && isVectTauriEnabled(settings)) ? getChatUUID() : null;
        const block = uuid ? buildStoryStateBlock(truncateAtLine(getStoryStateText(uuid), cfg.maxChars)) : '';
        setExtensionPrompt(STORY_STATE_PROMPT_TAG, block, settings.position, settings.depth, false);
        if (block) log.domain('injection', 'trace', `[StoryState] Injected ${block.length} chars under ${STORY_STATE_PROMPT_TAG}`);
        return { injected: !!block, chars: block.length };
    } catch (err) {
        log.warn('[StoryState] injection failed (non-fatal):', err);
        return { injected: false, chars: 0 };
    }
}
