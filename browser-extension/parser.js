// Extração dos arquivos da última resposta do assistente e validação do contrato.
// Se o site mudar e o botão "Aplicar" não achar a resposta, ajuste ASSISTANT_SELECTORS.

const ASSISTANT_SELECTORS = [
    '.ds-markdown',
    '[data-message-author-role="assistant"]',
    '.markdown'
];

const PLACEHOLDER_PATH = 'caminho/do/arquivo.ext';
const FILE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FILE\s*:\s*(.+?)\s*$/i;

// Violações do contrato (resposta com trechos em vez do arquivo inteiro)
const ELLIPSIS_LINE_RE = /^\s*(?:(?:\/\/|#|\/\*+|<!--|--|;)\s*)?(?:\.{3}|…)\s*(?:\*+\/|-->)?\s*$/m;
const PLACEHOLDER_LINE_RE = /^\s*(?:\/\/|#|\/\*+|<!--|<|--)\s*(?:\.{3}|…)?\s*(?:resto do c[oó]digo|restante do c[oó]digo|rest of (?:the )?(?:code|file|function|class)|remaining code|existing code|unchanged code|c[oó]digo (?:existente|anterior|original|omitido|inalterado))/im;
const DIFF_MARKER_RE = /^(?:@@ .+ @@|\+\+\+ [ab]\/|--- [ab]\/)/m;

// O bloco de "raciocínio" (DeepThink) também usa .ds-markdown; não é a resposta final.
const THINK_ANCESTOR_SELECTOR = '[class*="ds-think" i], [class*="think-content" i], [class*="thinking" i]';

function isThinkNode(node) {
    return !!(node.closest && node.closest(THINK_ANCESTOR_SELECTOR));
}

/** Todos os nós de resposta do assistente (sem o bloco de raciocínio), na ordem da página. */
function listAssistantMessages() {
    for (const selector of ASSISTANT_SELECTORS) {
        const nodes = [...document.querySelectorAll(selector)];
        if (nodes.length === 0) continue;
        const answers = nodes.filter(n => !isThinkNode(n));
        return answers.length > 0 ? answers : nodes;
    }
    return [];
}

function findLastAssistantMessage() {
    const nodes = listAssistantMessages();
    return nodes.length > 0 ? nodes[nodes.length - 1] : null;
}

function messageText(node) {
    return node ? (node.innerText || node.textContent || '') : '';
}

/** A resposta terminou com o marcador de fim (olhando só o final do texto)? */
function hasEndMarker(text) {
    const tail = text.trim().slice(-120);
    return tail.includes(END_MARKER);
}

/** 'continue' | 'done' | null — lido do final da resposta. */
function readStatus(text) {
    const tail = text.slice(-400);
    const re = /\[\[\s*STATUS\s*:\s*(CONTINUAR|CONCLU[IÍ]DO)\s*\]\]/gi;
    let last = null, m;
    while ((m = re.exec(tail)) !== null) last = m[1].toUpperCase();
    if (!last) return null;
    return last === 'CONTINUAR' ? 'continue' : 'done';
}

function cleanPath(raw) {
    return raw.replace(/^[\s`'"*]+|[\s`'"*]+$/g, '').replace(/\\/g, '/');
}

function isPlausiblePath(p) {
    return p.length > 0 && p.length < 260
        && !/[<>|?*"\0]/.test(p)
        && p !== PLACEHOLDER_PATH
        && !/^\.{1,2}$/.test(p)
        && /\w/.test(p);
}

function normalizeContent(text) {
    // Sem linhas em branco extras no começo; exatamente uma quebra de linha no fim
    return text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '') + '\n';
}

function codeTextOf(pre) {
    const code = pre.querySelector('code');
    return (code || pre).textContent || '';
}

function readFileMarker(node) {
    const firstLine = (node.textContent || '').trim().split('\n')[0];
    const m = FILE_MARKER_RE.exec(firstLine);
    if (!m) return null;
    const p = cleanPath(m[1]);
    return isPlausiblePath(p) ? p : null;
}

/** Caminho principal: percorre o DOM renderizado (título "FILE: x" seguido de um bloco <pre>). */
function parseFilesFromContainer(container) {
    const results = [];
    let pendingPath = null;

    for (const node of container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre')) {
        if (node.tagName === 'PRE') {
            if (pendingPath) {
                results.push({ filePath: pendingPath, content: normalizeContent(codeTextOf(node)) });
                pendingPath = null;
            }
            continue;
        }
        if (node.closest('pre')) continue;
        const p = readFileMarker(node);
        if (p) pendingPath = p;
    }
    return results;
}

/** Plano B: o texto veio em Markdown cru (com "###" e crases). */
function parseFilesFromText(text) {
    const regex = new RegExp(
        '^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?FILE[ \\t]*:[ \\t]*(.+?)[ \\t]*\\n[ \\t]*' + FENCE + '[\\w+#.-]*\\n([\\s\\S]*?)\\n?[ \\t]*' + FENCE,
        'gim'
    );
    const results = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        const p = cleanPath(m[1]);
        if (isPlausiblePath(p)) results.push({ filePath: p, content: normalizeContent(m[2]) });
    }
    return results;
}

function findViolations(filePath, content) {
    const problems = [];
    if (content.trim() === '') problems.push('conteúdo vazio');
    if (ELLIPSIS_LINE_RE.test(content)) problems.push('contém uma linha só com "..." (trecho omitido)');
    if (PLACEHOLDER_LINE_RE.test(content)) problems.push('contém placeholder do tipo "resto do código"');
    if (DIFF_MARKER_RE.test(content)) problems.push('parece um diff, não o arquivo completo');
    if (/^[\\/]/.test(filePath) || /^[a-zA-Z]:/.test(filePath) || filePath.split('/').includes('..')) {
        problems.push('caminho fora do projeto');
    }
    return problems;
}

/** Lê a última resposta do assistente. Retorna { error } ou { files, problems }. */
function parseLastResponse() {
    const container = findLastAssistantMessage();
    if (!container) {
        return { error: 'Não encontrei a última resposta na página (o site pode ter mudado; ajuste ASSISTANT_SELECTORS em parser.js).' };
    }

    let found = parseFilesFromContainer(container);
    if (found.length === 0) {
        found = parseFilesFromText(container.innerText || container.textContent || '');
    }
    if (found.length === 0) {
        return { error: 'Nenhum bloco "### FILE:" encontrado na última resposta.' };
    }

    // Se o mesmo arquivo aparecer duas vezes, vale o último
    const byPath = new Map();
    for (const f of found) byPath.set(f.filePath, f);
    const files = [...byPath.values()];

    const problems = [];
    for (const f of files) {
        for (const v of findViolations(f.filePath, f.content)) problems.push(`- ${f.filePath}: ${v}`);
    }
    return { files, problems };
}
