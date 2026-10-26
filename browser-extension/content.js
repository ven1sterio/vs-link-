const WS_URL = 'ws://127.0.0.1:8765';

// Ponte: a conexão real fica no background.js (service worker da extensão).
// Esta classe imita a API do WebSocket para o resto do código não mudar.
class BridgeSocket {
    constructor() {
        this.readyState = 0; // 0 conectando, 1 aberto, 3 fechado
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        this.port = chrome.runtime.connect({ name: 'vscode-bridge' });
        this.port.onMessage.addListener(m => {
            if (m.t === 'open') { this.readyState = 1; this.onopen && this.onopen(); }
            else if (m.t === 'msg') { this.onmessage && this.onmessage({ data: m.data }); }
            else if (m.t === 'close') { this._finish(); }
        });
        this.port.onDisconnect.addListener(() => this._finish());
    }
    _finish() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose && this.onclose();
    }
    send(data) {
        if (this.readyState === 1) this.port.postMessage({ t: 'send', data });
    }
    close() {
        try { this.port.disconnect(); } catch { /* ignore */ }
        this._finish();
    }
}

let ws = null;
let connected = false;
let waiting = null;              // requisição de contexto em andamento
let waitingApplyResult = null;   // apply+run em andamento (modo agente)
let nextIsDelta = false;
let reconnectTimer = null;

let statusDot = null;
let mainBtn = null;
let fullCodeToggle = null;
let toastEl = null;
let toastTimer = null;

// ---------- Estado do agente ----------
let fullCodeMode = false;
let agentRunning = false;
let agentIteration = 0;
const MAX_AGENT_ITERATIONS = 40;      // etapas (inclui correções) em um único pedido
const MAX_CONSECUTIVE_FAILURES = 6;   // erros seguidos (execução/formato) antes de desistir
const RESPONSE_TIMEOUT_MS = 600000;   // 10 min aguardando a resposta (inclui o raciocínio do DeepThink)
const APPLY_TIMEOUT_MS = 780000;      // 13 min aguardando apply+run (npm install + build)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Conexão com o VS Code ----------

function connect() {
    try {
        ws = new BridgeSocket();
    } catch (e) {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        connected = true;
        nextIsDelta = false;
        updateUI();
        console.log('Conectado ao VS Code Context Sync');
    };

    ws.onclose = () => {
        connected = false;
        updateUI();
        finishWaiting(null);
        finishWaitingApply({ status: 'error', message: 'Conexão com o VS Code foi fechada.' });
        agentRunning = false;
        scheduleReconnect();
    };

    ws.onerror = () => { /* onclose cuida da reconexão */ };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'context') {
            finishWaiting(msg);
        } else if (msg.type === 'applyResult') {
            const icon = msg.status === 'applied' ? '✅' : msg.status === 'cancelled' ? '⏹' : '❌';
            let text = `${icon} ${msg.message}`;
            if (typeof msg.runSuccess === 'boolean') {
                text += msg.runSuccess ? ' (execução OK)' : ' (execução falhou)';
            }
            toast(text);
            finishWaitingApply(msg);
        }
    };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
}

function isOpen() {
    return connected && ws && ws.readyState === 1;
}

function requestContext(mode) {
    return new Promise((resolve) => {
        if (!isOpen() || waiting) {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => finishWaiting(null), 5000);
        waiting = { resolve, timer };
        ws.send(JSON.stringify({ type: 'request', mode }));
    });
}

function finishWaiting(msg) {
    if (!waiting) return;
    clearTimeout(waiting.timer);
    const resolve = waiting.resolve;
    waiting = null;
    resolve(msg);
}

function finishWaitingApply(msg) {
    if (!waitingApplyResult) return;
    clearTimeout(waitingApplyResult.timer);
    const resolve = waitingApplyResult.resolve;
    waitingApplyResult = null;
    resolve(msg);
}

// ---------- Campo de texto do chat ----------

function findInput() {
    return document.querySelector('#chat-input')
        || document.querySelector('textarea')
        || document.querySelector('[contenteditable="true"]');
}

function readInput(input) {
    return input.tagName === 'TEXTAREA' ? input.value : (input.innerText || '');
}

function setInput(input, text) {
    if (input.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(text.length, text.length);
        input.scrollTop = input.scrollHeight;
    } else {
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
    }
}

// ---------- Anexar contexto (modo manual) ----------

async function handleAttach(mode) {
    if (agentRunning) { toast('Aguarde o agente terminar ou pare-o.'); return; }

    const input = findInput();
    if (!input) {
        toast('Campo de entrada não encontrado. A página pode ter mudado.');
        return;
    }

    const current = readInput(input);
    if (current.includes(PROMPT_MARKER)) {
        toast('O campo já contém um contexto anexado. Envie a mensagem (ou limpe o campo) antes de anexar de novo.');
        return;
    }
    const question = current.trim();

    toast('Buscando contexto...');
    const msg = await requestContext(mode);

    if (!msg) {
        toast('Sem resposta do VS Code. Deixe a janela com a extensão aberta e recarregue a página.');
        return;
    }
    if (msg.mode === 'empty') {
        toast('Nenhuma alteração desde o último envio.');
        return;
    }

    const kb = (msg.chars / 1024).toFixed(1);

    if (msg.mode === 'full') {
        setInput(input, buildFullPrompt({ tree: msg.tree, context: msg.data, question, fullCode: false }));
        nextIsDelta = true;
        let info = `Contexto completo: ${msg.files} arquivo(s), ${kb} KB.`;
        if (msg.omitted > 0) info += ` ${msg.omitted} omitido(s) por limite de tamanho.`;
        toast(info);
    } else {
        setInput(input, buildDeltaPrompt({ tree: msg.tree, changes: msg.data, question, fullCode: false }));
        let info = `Alterações: ${msg.files} arquivo(s), ${kb} KB.`;
        if (msg.tree) info += ' Estrutura atualizada.';
        if (msg.remaining > 0) info += ` Restam ${msg.remaining}; clique de novo para enviar.`;
        toast(info);
    }
    updateUI();
}

// ---------- Aplicar a resposta (modo manual) ----------

function handleApply() {
    if (agentRunning) { toast('Aguarde o agente terminar.'); return; }
    if (!isOpen()) {
        toast('Sem conexão com o VS Code.');
        return;
    }

    const result = parseLastResponse();
    if (result.error) {
        toast(result.error);
        return;
    }

    if (result.problems.length > 0) {
        alert(
            'O modelo não seguiu o contrato (arquivo incompleto):\n\n' +
            result.problems.join('\n') +
            '\n\nNada será aplicado. Peça novamente o arquivo COMPLETO.'
        );
        return;
    }

    ws.send(JSON.stringify({ type: 'applyFiles', files: result.files }));
    toast(`Aguardando confirmação no VS Code (${result.files.length} arquivo(s))...`);
}

// ---------- Utilidades do agente ----------

/**
 * Envia a mensagem que está no campo do chat.
 * Tenta Enter; se o campo não for limpo, tenta clicar no botão de enviar.
 * Retorna true se a mensagem foi enviada (input ficou vazio).
 */
async function pressSend() {
    const input = findInput();
    if (!input) return false;

    input.focus();
    await sleep(100);

    input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
    }));
    await sleep(300);

    if (readInput(input).trim().length > 0) {
        const sendBtn = document.querySelector(
            '[data-testid="send-button"], ' +
            'button[aria-label*="Send" i], ' +
            'button[aria-label*="Enviar" i], ' +
            'div[role="button"][aria-label*="Send" i]'
        );
        if (sendBtn) {
            sendBtn.click();
            await sleep(300);
        }
    }

    return readInput(input).trim().length === 0;
}

function findStopButton() {
    return document.querySelector(
        '[data-testid="stop-button"], ' +
        'button[aria-label*="Stop" i], button[aria-label*="Parar" i], ' +
        'button[title*="Stop" i], button[title*="Parar" i]'
    );
}

// Botão "Continuar gerando" que o site mostra quando a resposta é cortada por tamanho.
const CONTINUE_BTN_RE = /^(continuar( a)?( gerar| gerando| gera[cç][aã]o)?|continue( generating| generation)?|继续生成|继续)\s*[.…]*$/i;

function isVisible(el) {
    return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
}

function findContinueButton() {
    const candidates = document.querySelectorAll('button, [role="button"], div[class*="btn" i], span[class*="btn" i]');
    for (const el of candidates) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.length <= 32 && CONTINUE_BTN_RE.test(t) && isVisible(el)) return el;
    }
    return null;
}

/**
 * Aguarda o fim da geração do assistente.
 * Heurística (a lógica original, que funciona, + reforços):
 *  (a) apareceu uma resposta nova;
 *  (b) o texto estabilizou e não há botão de "Stop"; ou a resposta termina com END_MARKER;
 *  (c) se o site cortou a resposta e mostra "Continuar", o botão é clicado sozinho.
 * Sem o marcador final, espera mais tempo parado (o raciocínio do DeepThink faz pausas).
 * Respeita agentRunning (permite parar no meio).
 */
// Conta só mensagens de RESPOSTA (o bloco de raciocínio do DeepThink não conta), para não
// confundir "o modelo ainda está pensando" com "a resposta nova apareceu".
function snapshotAssistant() {
    const nodes = listAssistantMessages();
    return { count: nodes.length, last: nodes[nodes.length - 1] || null };
}

async function waitForResponseComplete(timeoutMs, baseline) {
    const start = Date.now();

    // A linha de base é tirada ANTES de enviar (se a resposta chegar rápido, não é perdida)
    const initialCount = baseline.count;
    const initialLast = baseline.last;
    let appeared = false;
    while (Date.now() - start < 120000) {
        if (!agentRunning) return false;
        await sleep(200);
        const now = snapshotAssistant();
        if (now.count > initialCount || (now.last && now.last !== initialLast)) { appeared = true; break; }
    }
    if (!appeared) return false;

    let lastText = '';
    let stableSince = Date.now();
    let continueClicks = 0;
    while (Date.now() - start < timeoutMs) {
        if (!agentRunning) return false;

        const text = messageText(findLastAssistantMessage());
        if (text !== lastText) {
            lastText = text;
            stableSince = Date.now();
        }
        const stableFor = Date.now() - stableSince;
        const ended = hasEndMarker(text);

        if (ended && stableFor > 1200) return true;

        // Resposta cortada pelo site: clica em "Continuar" e segue esperando
        if (!ended && stableFor > 1500 && continueClicks < 30) {
            const btn = findContinueButton();
            if (btn) {
                continueClicks++;
                toast(`⏩ Resposta cortada pelo site: clicando em "Continuar" (${continueClicks})...`);
                btn.click();
                stableSince = Date.now();
                await sleep(1500);
                continue;
            }
        }

        const needed = readStatus(text) ? 2500 : 8000;
        if (stableFor > needed && lastText.trim().length > 10 && !findStopButton()) return true;

        await sleep(300);
    }
    return false;
}

/** Envia arquivos para o VS Code aplicar (auto) e rodar. */
function sendApplyAndRun(files) {
    return new Promise((resolve) => {
        if (!isOpen()) { resolve(null); return; }
        if (waitingApplyResult) { resolve(null); return; }

        const timer = setTimeout(() => {
            finishWaitingApply({ status: 'error', message: 'Timeout aguardando VS Code (apply+run).' });
        }, APPLY_TIMEOUT_MS);

        waitingApplyResult = { resolve, timer };
        ws.send(JSON.stringify({ type: 'applyFiles', files, autoApply: true, runAfter: true }));
    });
}

// ---------- Agente Full Code ----------

function stopAgent() {
    agentRunning = false;
    finishWaitingApply({ status: 'error', message: 'Agente parado pelo usuário.' });
    toast('⏹ Agente parado.');
    updateUI();
}

async function startAgent() {
    if (!isOpen()) { toast('Sem conexão com o VS Code.'); return; }
    if (agentRunning) { toast('Agente já está rodando.'); return; }

    const input = findInput();
    if (!input) { toast('Campo de entrada não encontrado.'); return; }

    const current = readInput(input);
    if (current.includes(PROMPT_MARKER)) {
        toast('O campo já contém contexto. Limpe e escreva sua pergunta.');
        return;
    }
    const question = current.trim();
    if (!question) { toast('Digite a pergunta antes de rodar o agente.'); return; }

    agentRunning = true;
    agentIteration = 0;
    updateUI();

    try {
        await agentLoop(question);
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        toast('Erro no agente: ' + m);
    } finally {
        agentRunning = false;
        updateUI();
    }
}

async function agentLoop(initialQuestion) {
    let promptText = initialQuestion;
    let needContext = true;
    let failures = 0;          // erros seguidos
    let stages = 0;            // etapas aplicadas com sucesso

    while (agentRunning && agentIteration < MAX_AGENT_ITERATIONS) {
        agentIteration++;
        updateUI();
        toast(`⏳ Iteração ${agentIteration}/${MAX_AGENT_ITERATIONS}...`);

        // 1. Monta o texto a enviar
        let textToSend = promptText;
        if (needContext) {
            const msg = await requestContext('auto');
            if (!msg) { toast('VS Code não respondeu ao pedido de contexto.'); return; }

            if (msg.mode === 'empty') {
                // Nada mudou nos arquivos, mas há uma pergunta nova: envia só a pergunta
                textToSend = buildDeltaPrompt({ tree: undefined, changes: '', question: promptText, fullCode: true });
            } else if (msg.mode === 'full') {
                textToSend = buildFullPrompt({ tree: msg.tree, context: msg.data, question: promptText, fullCode: true });
                nextIsDelta = true;
            } else {
                textToSend = buildDeltaPrompt({ tree: msg.tree, changes: msg.data, question: promptText, fullCode: true });
            }
            needContext = false;
        }

        // 2. Injeta e envia (guarda o estado da página para reconhecer a resposta NOVA)
        const input = findInput();
        if (!input) { toast('Campo de entrada perdido.'); return; }
        const baseline = snapshotAssistant();
        setInput(input, textToSend);
        await sleep(150);

        const sent = await pressSend();
        if (!sent) { toast('Não consegui enviar a mensagem.'); return; }

        // 3. Aguarda a resposta
        toast(`💬 Iteração ${agentIteration}: aguardando o DeepSeek...`);
        const ok = await waitForResponseComplete(RESPONSE_TIMEOUT_MS, baseline);
        if (!ok) {
            if (!agentRunning) return; // parada pelo usuário
            toast('Timeout: não detectei a resposta do DeepSeek terminar (o site pode ter mudado: veja ASSISTANT_SELECTORS em parser.js).');
            return;
        }
        await sleep(800);

        // 4. Lê e interpreta a resposta
        const answerNode = findLastAssistantMessage();
        if (!answerNode) { toast('Não encontrei a resposta na página (ajuste ASSISTANT_SELECTORS em parser.js).'); return; }
        const status = readStatus(messageText(answerNode));      // 'continue' | 'done' | null
        const parsed = parseLastResponse();

        if (parsed.error) {
            // Sem arquivos
            if (status === 'continue') {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ O modelo não está enviando arquivos. Encerrado.'); return; }
                promptText = 'Você indicou ' + STATUS_CONTINUE + ' mas não enviou nenhum bloco "### FILE:". ' +
                    'Envie agora os arquivos COMPLETOS da próxima etapa (máximo 20).';
                continue;
            }
            // Sem status e sem marcador, terminando com pergunta/“continuar”: o modelo pediu confirmação
            const answerText = messageText(answerNode);
            const asked = !hasEndMarker(answerText) && !status && /(continu|prosseg|quer que|deseja|posso seguir|confirm)/i.test(answerText.slice(-300));
            if (asked) {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ O modelo só pede confirmação e não envia arquivos. Encerrado.'); return; }
                toast('↪ O modelo pediu confirmação/foi cortado: respondendo "continuar" sozinho...');
                promptText = 'Sim, continue. Não peça confirmação. Se sua resposta anterior foi cortada, reenvie a etapa em partes ' +
                    'menores (no máximo 4 arquivos COMPLETOS por resposta). Termine com ' + STATUS_CONTINUE + ' ou ' + STATUS_DONE +
                    ' e depois ' + END_MARKER + '.';
                continue;
            }
            toast(`✅ Agente encerrado: o modelo terminou sem novos arquivos. (${stages} etapa(s) aplicada(s))`);
            return;
        }

        if (parsed.problems.length > 0) {
            failures++;
            if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ O modelo continua violando o formato. Encerrado.'); return; }
            promptText = 'Sua resposta anterior violou o contrato:\n' + parsed.problems.join('\n') +
                '\n\nReenvie os arquivos COMPLETOS no formato "### FILE:" (máximo 20 por resposta), ' +
                'terminando com ' + STATUS_CONTINUE + ' ou ' + STATUS_DONE + ' e depois ' + END_MARKER + '.';
            continue;
        }

        // 5. Aplica + roda no VS Code
        toast(`🛠️ Aplicando ${parsed.files.length} arquivo(s) e executando...`);
        const res = await sendApplyAndRun(parsed.files);
        if (!res) { toast('VS Code não respondeu.'); return; }

        if (res.status === 'cancelled') { toast('Aplicação cancelada.'); return; }

        if (res.status === 'error') {
            failures++;
            if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ Muitas falhas seguidas ao aplicar. Encerrado: ' + res.message); return; }
            promptText = `Falha ao aplicar: ${res.message}\n\nReenvie os arquivos corrigidos (máximo 20 por resposta).`;
            continue;
        }

        // 6. Execução falhou → realimenta o modelo
        if (res.runSuccess === false) {
            failures++;
            if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ A execução continua falhando após várias correções. Encerrado.'); return; }
            const out = (res.runOutput || '').slice(-12000);
            promptText =
                'Os arquivos foram aplicados mas a execução falhou.\n\n' +
                `Comando: ${res.runCommand || '(desconhecido)'}` +
                (typeof res.runExitCode === 'number' ? ` (código de saída ${res.runExitCode})` : '') + '\n' +
                'Saída:\n```\n' + out + '\n```\n\n' +
                'Corrija e reenvie os arquivos COMPLETOS no formato "### FILE:" (máximo 20 por resposta). ' +
                'Termine com ' + STATUS_CONTINUE + ' ou ' + STATUS_DONE + ' e depois ' + END_MARKER + '.';
            continue;
        }

        // 7. Etapa aplicada (e executada) com sucesso
        failures = 0;
        stages++;
        const dur = res.runDurationMs ? ` (${(res.runDurationMs / 1000).toFixed(1)}s)` : '';

        if (status === 'continue') {
            toast(`✔ Etapa ${stages} aplicada${dur}. Pedindo a próxima...`);
            const outTail = (res.runOutput || '').slice(-1500);
            promptText =
                `Etapa aplicada com sucesso. Execução OK${res.runCommand ? ` (comando: ${res.runCommand})` : ''}.\n` +
                (outTail ? 'Saída:\n```\n' + outTail + '\n```\n\n' : '\n') +
                'Continue com a PRÓXIMA etapa do seu plano (arquivos COMPLETOS, máximo 20). ' +
                'Quando a aplicação estiver completa e funcionando, termine com ' + STATUS_DONE + '. ' +
                'Termine sempre com ' + END_MARKER + '.';
            continue;
        }

        toast(`✅ Agente concluiu! ${stages} etapa(s) aplicada(s)${dur}`);
        return;
    }

    if (agentRunning && agentIteration >= MAX_AGENT_ITERATIONS) {
        toast(`⏹ Limite de ${MAX_AGENT_ITERATIONS} iterações atingido.`);
    }
}

// ---------- Interface ----------

function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 6000);
}

function updateUI() {
    if (statusDot) statusDot.style.backgroundColor = connected ? '#34a853' : '#ea4335';

    if (fullCodeToggle) {
        fullCodeToggle.style.backgroundColor = fullCodeMode ? '#ff6d00' : '#5f6368';
        fullCodeToggle.title = fullCodeMode
            ? 'Full Code ATIVO: envia, aplica e roda automaticamente em loop.'
            : 'Full Code desativado. Clique para ativar o modo agente.';
    }

    if (mainBtn) {
        if (agentRunning) {
            mainBtn.textContent = `⏹ Parar agente (it. ${agentIteration})`;
            mainBtn.style.backgroundColor = '#c62828';
        } else if (fullCodeMode) {
            mainBtn.textContent = '🚀 Rodar agente (Full Code)';
            mainBtn.style.backgroundColor = '#ff6d00';
        } else {
            mainBtn.textContent = nextIsDelta ? '📎 Anexar alterações' : '📎 Anexar contexto do projeto';
            mainBtn.style.backgroundColor = '#1a73e8';
        }
    }
}

function styleButton(btn, bg) {
    btn.style.padding = '8px 14px';
    btn.style.backgroundColor = bg;
    btn.style.color = 'white';
    btn.style.border = 'none';
    btn.style.borderRadius = '6px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '13px';
    btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
}

function addUI() {
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.bottom = '80px';
    box.style.right = '20px';
    box.style.zIndex = '10000';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.alignItems = 'flex-end';
    box.style.gap = '6px';

    toastEl = document.createElement('div');
    toastEl.style.display = 'none';
    toastEl.style.maxWidth = '320px';
    toastEl.style.padding = '6px 10px';
    toastEl.style.backgroundColor = 'rgba(0,0,0,0.85)';
    toastEl.style.color = 'white';
    toastEl.style.borderRadius = '6px';
    toastEl.style.fontSize = '12px';

    const applyBtn = document.createElement('button');
    applyBtn.textContent = '📥 Aplicar resposta';
    applyBtn.title = 'Aplica no VS Code os arquivos "### FILE:" da última resposta (espere ela terminar). Você confirma lá.';
    styleButton(applyBtn, '#2e7d32');
    applyBtn.onclick = handleApply;

    // Linha 1: status + toggle Full Code
    const row1 = document.createElement('div');
    row1.style.display = 'flex';
    row1.style.gap = '6px';
    row1.style.alignItems = 'center';

    statusDot = document.createElement('span');
    statusDot.style.width = '10px';
    statusDot.style.height = '10px';
    statusDot.style.borderRadius = '50%';
    statusDot.title = 'Conexão com o VS Code';

    fullCodeToggle = document.createElement('button');
    fullCodeToggle.textContent = '🔁 Full Code';
    styleButton(fullCodeToggle, '#5f6368');
    fullCodeToggle.onclick = () => {
        if (agentRunning) { toast('Pare o agente antes de alternar o modo.'); return; }
        fullCodeMode = !fullCodeMode;
        updateUI();
        toast(fullCodeMode
            ? '🔁 Full Code ATIVO: enviará, aplicará e executará automaticamente.'
            : '⏹ Full Code desativado.');
    };

    row1.append(statusDot, fullCodeToggle);

    // Linha 2: contexto completo + botão principal (anexar / rodar agente / parar)
    const row2 = document.createElement('div');
    row2.style.display = 'flex';
    row2.style.gap = '6px';
    row2.style.alignItems = 'center';

    const fullBtn = document.createElement('button');
    fullBtn.textContent = '🔄 Contexto completo';
    fullBtn.title = 'Reenvia o projeto inteiro (use em uma conversa nova)';
    styleButton(fullBtn, '#5f6368');
    fullBtn.onclick = () => handleAttach('full');

    mainBtn = document.createElement('button');
    styleButton(mainBtn, '#1a73e8');
    mainBtn.onclick = () => {
        if (agentRunning) {
            stopAgent();
        } else if (fullCodeMode) {
            startAgent();
        } else {
            handleAttach('auto');
        }
    };

    row2.append(fullBtn, mainBtn);

    box.append(toastEl, applyBtn, row1, row2);
    document.body.appendChild(box);
    updateUI();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addUI);
} else {
    addUI();
}

connect();
