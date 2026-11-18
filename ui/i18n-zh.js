/**
 * VectTauri 简体中文界面本地化模块 (Non-invasive DOM + Toastr i18n)
 */

const EXACT_MAP = new Map([
    // 主面板与标签页
    ['VectTauri - Advanced RAG', 'VectTauri - 高级向量记忆 (汉化版)'],
    ['Enable VectTauri', '启用 VectTauri'],
    ['Master switch. When off, VectTauri stops all automatic retrieval injection, auto-sync, and lorebook injection. Manual tools (Database Browser, Vectorize Content) stay available.', '总开关。关闭后将停止所有自动检索注入、自动同步与世界书注入，但手动工具（数据库浏览器、内容向量化）仍可使用。'],
    ['Action', '操作'],
    ['Core', '核心'],
    ['EventBase', '事件库'],
    ['ChunkBase', '分块库'],
    ['AutoSync', '自动同步'],
    ['WorldInfo', '世界书'],
    ['RAG', '检索'],
    ['Diagnostics', '诊断'],

    // 常用按钮与状态
    ['Save', '保存'],
    ['Save changes', '保存更改'],
    ['Save & Re-embed', '保存并重新向量化'],
    ['Cancel', '取消'],
    ['Close', '关闭'],
    ['Delete', '删除'],
    ['Delete Selected', '删除选中'],
    ['Confirm', '确认'],
    ['Apply', '应用'],
    ['Reset', '重置'],
    ['Reset to Default', '恢复默认'],
    ['Reset to defaults', '恢复默认设置'],
    ['Refresh', '刷新'],
    ['Refresh Now', '立即刷新'],
    ['Reload', '重新加载'],
    ['↺ Reload', '↺ 重新加载'],
    ['Install', '安装'],
    ['Install the plugin', '安装插件'],
    ['Preview', '预览'],
    ['Filter', '筛选'],
    ['Clear filter', '清除筛选'],
    ['Filter: All', '筛选：全部'],
    ['Show all', '显示全部'],
    ['Show all collections', '显示全部集合'],
    ['Enable All', '全部启用'],
    ['Disable All', '全部禁用'],
    ['Enabled', '已启用'],
    ['Disabled', '已禁用'],
    ['Enabled Only', '仅已启用'],
    ['Disabled Only', '仅已禁用'],
    ['Done', '完成'],
    ['Passed', '通过'],
    ['Failed', '失败'],
    ['Errors', '错误'],
    ['Warnings', '警告'],
    ['Paused', '已暂停'],
    ['Resume', '继续'],
    ['Purge', '清空'],
    ['Vectorize', '向量化'],
    ['Vectorize Content', '内容向量化'],
    ['Sync Chat', '同步聊天'],
    ['Database Browser', '数据库浏览器'],
    ['🗃️ VECTTAURI Database Browser', '🗃️ VectTauri 数据库浏览器'],
    ['Visualizer', '分块可视化'],
    ['Search Debug', '检索调试'],
    ['Debug Query', '调试查询'],
    ['Run Diagnostics', '运行诊断'],
    ['Running diagnostics...', '正在运行诊断...'],
    ['Loading...', '加载中...'],
    ['Processing...', '处理中...'],
    ['Initializing...', '初始化中...'],

    // Core 核心设置
    ['Vector Backend', '向量后端'],
    ['Vector backend', '向量后端'],
    ['Vector database backend', '向量数据库后端'],
    ['Backend', '后端'],
    ['Backend Health', '后端健康状态'],
    ['Backend Health Dashboard', '后端健康仪表盘'],
    ['Standard (ST\'s Vectra - file-based)', '标准模式（文件存储 Vectra）'],
    ['Qdrant (production vector search)', 'Qdrant（高性能生产级向量库）'],
    ['Qdrant Cloud URL:', 'Qdrant Cloud 地址：'],
    ['Qdrant Host:', 'Qdrant 主机：'],
    ['Qdrant Port:', 'Qdrant 端口：'],
    ['Use Qdrant Cloud', '使用 Qdrant Cloud'],
    ['Use Multitenancy (Single Collection)', '启用多租户（单集合模式）'],
    ['Embedding Provider', '向量模型提供方'],
    ['Embedding provider and model', '向量模型提供方与模型'],
    ['Embedding source', '向量来源'],
    ['Embedding Model:', '向量模型：'],
    ['Embeddings Endpoint:', '向量接口地址：'],
    ['API Key', 'API 密钥'],
    ['API Key:', 'API 密钥：'],
    ['Clear saved key', '清除已保存密钥'],
    ['— Select a model —', '— 选择模型 —'],
    ['— Select an embedding model —', '— 选择向量模型 —'],
    ['Transformers (Local)', '本地 Transformers'],
    ['Ollama', 'Ollama'],
    ['Ollama Model:', 'Ollama 模型：'],
    ['vLLM', 'vLLM'],
    ['vLLM Base URL', 'vLLM 接口地址'],
    ['vLLM Model:', 'vLLM 模型：'],
    ['vLLM API Key (optional):', 'vLLM API 密钥（可选）：'],
    ['OpenRouter', 'OpenRouter'],
    ['OpenRouter API Key:', 'OpenRouter API 密钥：'],
    ['OpenRouter Model:', 'OpenRouter 模型：'],
    ['Browse OpenRouter', '浏览 OpenRouter 模型'],
    ['Custom (OpenAI-compatible)', '自定义（OpenAI 兼容接口）'],
    ['Electron Hub', 'Electron Hub'],
    ['Keep Model in Memory', '将模型常驻内存'],
    ['Switch Embedding Model', '切换向量模型'],
    ['Embedding API Rate Limiting (0 to disable)', '向量 API 速率限制（0 为不限制）'],
    ['Max Calls', '最大调用数'],
    ['Interval (sec)', '时间间隔（秒）'],
    ['Batch Size:', '批处理大小：'],
    ['Retrieval Timeout (ms)', '检索超时（毫秒）'],
    ['Per-query Timeout (ms)', '单次查询超时（毫秒）'],
    ['Summarization Timeout (ms)', '摘要超时（毫秒）'],
    ['Extraction Timeout (ms)', '提取超时（毫秒）'],
    ['Planner LLM Timeout (ms)', '规划器超时（毫秒）'],

    // RAG / 检索与 BM25
    ['Retrieval', '检索设置'],
    ['Retrieval Tuning', '检索调优'],
    ['Retrieval Gating', '检索门控'],
    ['Retrieve Top-K', '召回数量 (Top-K)'],
    ['Top K', 'Top-K 数量'],
    ['Score Threshold', '相似度阈值'],
    ['Similarity Threshold:', '相似度阈值：'],
    ['Min score:', '最低分数：'],
    ['Injection Position', '注入位置'],
    ['Injection position:', '注入位置：'],
    ['Injection Depth:', '注入深度：'],
    ['Injection depth:', '注入深度：'],
    ['Injection Format', '注入格式'],
    ['Before Main Prompt', '主提示词之前'],
    ['In-Chat', '聊天记录内'],
    ['In-Chat @ Depth', '聊天内指定深度'],
    ['Global XML Tag (optional)', '全局 XML 标签（可选）'],
    ['XML tag (optional):', 'XML 标签（可选）：'],
    ['XML tag:', 'XML 标签：'],
    ['Minimum Messages Before Injection', '开始注入前的最少消息数'],
    ['Max injection size (characters, 0 = no cap)', '最大注入字符数（0 为不限制）'],
    ['Fusion Method', '融合方式'],
    ['RRF (Reciprocal Rank Fusion)', 'RRF（倒数排名融合）'],
    ['RRF K Constant:', 'RRF K 常数：'],
    ['Weighted Linear Combination', '加权线性组合'],
    ['Re-rank Weights', '重排权重'],
    ['Vector Weight:', '向量权重：'],
    ['Text Weight:', '文本权重：'],
    ['Base Weight:', '基础权重：'],
    ['BM25 (fast re-rank of top-K)', 'BM25（Top-K 快速重排）'],
    ['BM25 b (Length norm):', 'BM25 b（长度归一化）：'],
    ['BM25 k1 (TF saturation):', 'BM25 k1（词频饱和度）：'],
    ['CJK Tokenizer Mode', '中日韩分词模式'],
    ['CJK tokenizer and stopwords for BM25', 'BM25 的中日韩分词与停用词'],
    ['Custom Stopwords', '自定义停用词'],
    ['Hybrid (vector candidates + BM25 fusion)', '混合检索（向量候选 + BM25 融合）'],
    ['Cosine (semantic)', '余弦相似度（语义）'],
    ['Enable AgentMode', '启用 Agent 智能检索模式'],
    ['Max planner queries:', '规划器最大查询数：'],
    ['Candidates shown to planner:', '展示给规划器的候选数：'],
    ['Past chat turns sent to planner:', '发给规划器的历史轮数：'],
    ['Planner Max Output Tokens', '规划器最大输出 Token'],

    // EventBase / Summarizer / AutoSync
    ['Summarization', '摘要设置'],
    ['Summarization Provider', '摘要模型提供方'],
    ['Summarization / EventBase Model', '摘要 / 事件提取模型'],
    ['LLM for EventBase event extraction', '用于 EventBase 事件提取的 LLM'],
    ['LLM Provider', 'LLM 提供方'],
    ['Model:', '模型：'],
    ['Model', '模型'],
    ['Temperature', '温度 (Temperature)'],
    ['Max Output Tokens', '最大输出 Token'],
    ['Use max_completion_tokens', '使用 max_completion_tokens 参数'],
    ['Turn off model thinking', '关闭模型思考 (Thinking)'],
    ['Extraction', '事件提取'],
    ['Extraction Prompt', '提取提示词'],
    ['Custom Extraction Prompt (advanced)', '自定义提取提示词（高级）'],
    ['Max Events per Window', '每窗口最大事件数'],
    ['Parallel Batches:', '并发批次数：'],
    ['Min Importance to Store', '入库最低重要度'],
    ['Min Importance for Retrieval', '检索最低重要度'],
    ['Dedup Window Gap:', '去重窗口间隔：'],
    ['Skip Already-Visible Events:', '跳过当前可见事件：'],
    ['Summarizer Injection', '摘要注入'],
    ['Summarizer Injection — preview', '摘要注入 — 预览'],
    ['Summarize Before Store', '入库前先摘要'],
    ['Dual-Vector Summaries', '双向量摘要'],
    ['Ghost vectorized messages (token saver)', '幽灵化已向量化消息（大幅省 Token）'],
    ['Auto-Sync new messages (requires initial vectorization)', '自动同步新消息（需先完成初始向量化）'],
    ['Enable Auto-Sync', '启用自动同步'],
    ['Start From Message', '起始消息楼层'],
    ['Show progress modal during auto-sync', '自动同步时显示进度弹窗'],

    // WorldInfo / Database Browser / Tools
    ['Lorebook / World Info', '世界书 (Lorebook)'],
    ['Enable Semantic WI Activation', '启用语义世界书激活'],
    ['Test Semantic WI', '测试语义世界书'],
    ['Top-K per Lorebook', '每本世界书召回数 (Top-K)'],
    ['Include Disabled Entries', '包含已禁用条目'],
    ['Collection', '集合'],
    ['Collection Name', '集合名称'],
    ['Collection detail', '集合详情'],
    ['⚙️ Collection Settings', '⚙️ 集合设置'],
    ['✏️ Rename Collection', '✏️ 重命名集合'],
    ['🔒 Manage Locks', '🔒 管理锁定'],
    ['🔒 Lock', '🔒 锁定'],
    ['Remove lock', '解除锁定'],
    ['Collection locked to current chat', '集合已锁定到当前聊天'],
    ['Collection locked to current character', '集合已锁定到当前角色'],
    ['Character Locks', '角色锁定'],
    ['Chat Locks', '聊天锁定'],
    ['Active for current chat', '对当前聊天生效'],
    ['When enabled, this collection is active for the current chat', '启用后，该集合将在当前聊天中生效'],
    ['Export collection', '导出集合'],
    ['Export as JSON (includes vectors)', '导出为 JSON（含向量）'],
    ['Export as PNG (shareable image)', '导出为 PNG（可分享图片）'],
    ['Import collection from file', '从文件导入集合'],
    ['Purge collection and start fresh', '清空集合并重新开始'],
    ['Cleanup Corrupted', '清理损坏集合'],
    ['Clear registry and rescan from disk', '清除索引并从磁盘重扫'],
    ['Chunking Strategy', '分块策略'],
    ['Auto-Reformat (LLM)', 'LLM 自动重排格式'],
    ['Auto-Reformat (Optional)', '自动重排格式（可选）'],
    ['What do you want to vectorize?', '你想向量化什么内容？'],
    ['Current Chat history', '当前聊天记录'],
    ['Character Cards', '角色卡'],
    ['URLs / web pages', '网页 / URL'],
    ['YouTube transcripts', 'YouTube 字幕'],
    ['Text Cleaning', '文本清洗'],
    ['Manage Cleaning Patterns', '管理清洗规则'],
    ['Built-in Patterns', '内置规则'],
    ['Custom Patterns', '自定义规则'],
    ['Pattern Tester', '正则测试器'],
    ['Edit Chunk Text', '编辑分块文本'],
    ['Keywords', '关键词'],
    ['Conditions', '条件'],
    ['Triggers', '触发器'],
    ['🎯 Activation Triggers', '🎯 激活触发器'],
    ['⚡ Advanced Conditions', '⚡ 高级条件'],
    ['💬 Prompt Context', '💬 提示词上下文'],
    ['+ Add', '+ 添加'],
    ['+ Add Condition Rule', '+ 添加条件规则'],
    ['+ Add Link', '+ 添加关联'],
    ['+ Add Summary', '+ 添加摘要'],
    ['🔍 Search...', '🔍 搜索...'],
    ['Search across all collections...', '在全部集合中搜索...'],
    ['Search chunks by text, keywords, or name...', '按文本、关键词或名称搜索分块...'],
    ['Search collections...', '搜索集合...'],
    ['Bulk Select Mode', '批量选择模式'],
    ['Debug Injection Logging', '调试注入日志'],
    ['Pipeline Trace Log', '流水线追踪日志'],
    ['Injection Log', '注入日志'],
    ['Health Checks', '健康检查'],
    ['Production Tests', '生产环境测试'],
    ['Copy diagnostic dump', '复制诊断报告'],
    ['Popup: show retrieved result count', '弹窗：显示召回结果数量'],
    ['Popup: show when auto-sync is extracting', '弹窗：自动同步提取事件时提示'],
    ['Popup: show when backend retrieval starts', '弹窗：后端开始检索时提示'],
    ['Popup: show when lorebook entries are retrieved', '弹窗：召回世界书条目时提示'],

    // Toast 通知
    ['Collection settings saved', '集合设置已保存'],
    ['Chunk updated successfully', '分块更新成功'],
    ['Chunk deleted', '分块已删除'],
    ['Deleted collection', '已删除集合'],
    ['Ghost collection deleted', '已删除空集合'],
    ['Chat auto-sync enabled', '已开启当前聊天自动同步'],
    ['Auto-sync disabled for this chat', '已关闭当前聊天自动同步'],
    ['Text cleaning settings saved', '文本清洗设置已保存'],
    ['Diagnostic dump copied to clipboard', '诊断报告已复制到剪贴板'],
    ['Registry cleared and resynced from disk', '索引已清除并从磁盘重新同步'],
    ['Scan complete — registry updated', '扫描完成 — 索引已更新'],
    ['Open a chat first', '请先打开一个聊天'],
    ['Please enter a search query', '请输入搜索关键词'],
    ['Please select an embedding provider', '请先选择向量模型提供方'],
    ['A vectorization is already running', '已有向量化任务正在运行'],
    ['Vectorization stopped', '向量化已停止'],
    ['Vectorize cancelled', '已取消向量化'],
    ['No collections found.', '未找到任何集合。'],
    ['No active chat;', '当前没有打开的聊天；'],
]);

const PREFIX_RULES = [
    [/^(\d+)\s+chunks?$/, '$1 个分块'],
    [/^(\d+)\s+selected$/, '已选 $1 项'],
    [/^(\d+)\s+occurrence\(s\)$/, '出现 $1 次'],
    [/^(\d+)\s+condition\(s\)$/, '$1 条条件'],
    [/^(\d+)\s+trigger\(s\)$/, '$1 个触发器'],
    [/^Deleted collection\s+(.+)$/, '已删除集合 $1'],
    [/^Renamed to\s+(.+)$/, '已重命名为 $1'],
    [/^Failed to\s+(.+)$/, '操作失败：$1'],
];

export function translateText(str) {
    if (!str || typeof str !== 'string') return str;
    const trimmed = str.trim();
    if (!trimmed) return str;
    const hit = EXACT_MAP.get(trimmed);
    if (hit) return str.replace(trimmed, hit);
    for (const [re, rep] of PREFIX_RULES) {
        if (re.test(trimmed)) {
            return str.replace(trimmed, trimmed.replace(re, rep));
        }
    }
    return str;
}

function isVectTauriNode(el) {
    if (!el || el.nodeType !== 1) return false;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    return /vecttauri|vt-|vf-/i.test(id) || /vecttauri|vt-|vf-/i.test(cls);
}

function translateSubtree(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'CODE' || tag === 'PRE') continue;
        const orig = node.nodeValue;
        const next = translateText(orig);
        if (next !== orig) node.nodeValue = next;
    }

    const els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label]') : [];
    for (const el of els) {
        for (const attr of ['placeholder', 'title', 'aria-label']) {
            const val = el.getAttribute(attr);
            if (val) {
                const next = translateText(val);
                if (next !== val) el.setAttribute(attr, next);
            }
        }
    }
}

let _initialized = false;

export function initZhLocalization() {
    if (_initialized || typeof document === 'undefined') return;
    _initialized = true;

    // 1. 包装 toastr 通知（仅翻译字典命中项）
    if (typeof window !== 'undefined' && window.toastr) {
        for (const fnName of ['info', 'success', 'warning', 'error']) {
            const origFn = window.toastr[fnName];
            if (typeof origFn === 'function') {
                window.toastr[fnName] = function (msg, title, opts) {
                    return origFn.call(this, translateText(msg), translateText(title), opts);
                };
            }
        }
    }

    // 2. 翻译已挂载的 VectTauri 容器
    const sweep = () => {
        const settingsEl = document.getElementById('VectTauri_settings');
        if (settingsEl) translateSubtree(settingsEl);
        for (const el of document.querySelectorAll('[id*="vecttauri" i], [id*="vt-"], [class*="vecttauri-modal"], [class*="vt-modal"]')) {
            translateSubtree(el);
        }
    };
    sweep();

    // 3. 监听后续动态渲染的弹窗与标签页
    let pending = false;
    const obs = new MutationObserver((mutations) => {
        let shouldRun = false;
        for (const m of mutations) {
            const tgt = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
            if (tgt && (tgt.closest?.('#VectTauri_settings') || isVectTauriNode(tgt) || [...m.addedNodes].some(isVectTauriNode))) {
                shouldRun = true;
                break;
            }
        }
        if (shouldRun && !pending) {
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                sweep();
            });
        }
    });
    if (document.body) {
        obs.observe(document.body, { childList: true, subtree: true });
    }
}
