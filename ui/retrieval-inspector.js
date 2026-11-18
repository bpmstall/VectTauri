/**
 * ============================================================================
 * RETRIEVAL INSPECTOR UI
 * ============================================================================
 * "Last retrieval" popup for the EventBase tab: explains which events the most
 * recent generation retrieved and injected (with scores), and which near-miss
 * candidates were dropped and why. Data comes from core/retrieval-trace.js.
 * ============================================================================
 */

import { getCurrentChatId } from '../../../../../script.js';
import StringUtils from '../utils/string-utils.js';
import { getLastRetrievalTrace } from '../core/retrieval-trace.js';

const STATUS_LABELS = {
    injected: 'Injected',
    below_top_k: 'Below top-K',
    below_min_importance: 'Below min importance',
    deduped: 'Deduped',
    filtered_other: 'Filtered (in context)',
};

const esc = (v) => StringUtils.escapeHtml(String(v ?? ''));
const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '—');

function _componentsText(c) {
    if (!c) return '—';
    if (c.formula != null) {
        // Native (Qdrant) rerank: server-side formula score, parts not exposed.
        return `formula ${fmt(c.formula)}${c.anchor ? ` + anchor ${fmt(c.anchor)}` : ''}`;
    }
    const parts = [['cos', c.cosine], ['imp', c.importance], ['pst', c.persist], ['rec', c.recency], ['anc', c.anchor]];
    return parts.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
}

/** @returns {string} table rows HTML for the candidates that pass the filters */
export function renderTraceRows(trace, { text = '', onlyDropped = false } = {}) {
    const needle = String(text || '').trim().toLowerCase();
    const rows = (trace?.candidates || []).filter(c => {
        if (onlyDropped && c.status === 'injected') return false;
        if (!needle) return true;
        return `${c.summary} ${c.key} ${c.eventType || ''}`.toLowerCase().includes(needle);
    });
    if (!rows.length) {
        return '<tr><td colspan="6" style="opacity:0.8;">No candidates match the current filter.</td></tr>';
    }
    return rows.map(c => `<tr>
        <td>${c.rank ?? '—'}</td>
        <td><span class="vecttauri-trace-badge vecttauri-trace-${esc(c.status)}" title="${esc(c.note || '')}">${esc(STATUS_LABELS[c.status] || c.status)}</span></td>
        <td>${fmt(c.finalScore)}</td>
        <td>${esc(_componentsText(c.components))}</td>
        <td>${c.importance ?? '—'}</td>
        <td class="vecttauri-trace-summary">${esc(c.summary)}${c.eventType ? ` <small style="opacity:0.7;">[${esc(c.eventType)}]</small>` : ''}</td>
    </tr>`).join('');
}

/** Open the "Last retrieval" popup for the current chat. */
export async function openRetrievalInspector() {
    const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');
    const trace = getLastRetrievalTrace(getCurrentChatId());

    const root = document.createElement('div');
    root.style.textAlign = 'left';

    if (!trace) {
        root.innerHTML = `<h3 style="margin:0 0 8px;">Last retrieval</h3>
            <p style="margin:0;">Nothing retrieved yet for this chat. Send a message (with EventBase active and the inspector enabled) and reopen this panel.</p>`;
        await callGenericPopup(root, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, large: true });
        return;
    }

    const when = new Date(trace.ts).toLocaleTimeString();
    const mode = trace.rerank === 'native' ? 'native (Qdrant) rerank' : trace.rerank === 'mixed' ? 'native + JS rerank' : 'JS rerank pipeline';
    root.innerHTML = `<h3 style="margin:0 0 6px;">Last retrieval</h3>
        <p style="margin:0 0 4px; opacity:0.85; word-break:break-word;">${when} · backend <strong>${esc(trace.backend)}</strong> · ${esc(mode)}${trace.agentic ? ' · agentic' : ''} · <strong>${trace.injectedCount}</strong> injected of ${trace.totalCandidates} candidate(s)${trace.truncated ? ' (list capped)' : ''}</p>
        <p style="margin:0 0 8px; opacity:0.85; word-break:break-word;">Query: <em>${esc(trace.query) || '(empty)'}</em></p>
        <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px;">
            <input type="text" class="vecttauri-input" data-role="filter" placeholder="Filter by text / event id" style="flex:1 1 12em; min-width:0;" />
            <label class="checkbox_label"><input type="checkbox" data-role="dropped" /><span>Show only dropped</span></label>
        </div>
        <div class="vecttauri-trace-scroll" style="max-height:50vh; overflow-y:auto;">
            <table class="vecttauri-trace-table">
                <thead><tr><th>#</th><th>Status</th><th>Score</th><th>Components</th><th>Imp</th><th>Summary</th></tr></thead>
                <tbody data-role="rows"></tbody>
            </table>
        </div>
        <small class="VectTauri_hint" style="display:block; margin-top:8px;">Event not here? <strong>Search stored events</strong> (Database Browser) to find out why: it was <em>never stored</em> (not in the database), <em>retrieved but ranked low</em> (listed above as dropped, or absent from the candidates), or <em>injected but ignored by the model</em> (status Injected, so the prompt contained it).</small>`;

    const rowsEl = root.querySelector('[data-role="rows"]');
    const filterEl = root.querySelector('[data-role="filter"]');
    const droppedEl = root.querySelector('[data-role="dropped"]');
    const refresh = () => {
        rowsEl.innerHTML = renderTraceRows(trace, { text: filterEl.value, onlyDropped: droppedEl.checked });
    };
    filterEl.addEventListener('input', refresh);
    droppedEl.addEventListener('change', refresh);
    refresh();

    await callGenericPopup(root, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, large: true });
}
