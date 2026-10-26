"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsServer = void 0;
const ws_1 = require("ws");
class WsServer {
    constructor(contextManager, port = 8765, onError) {
        this.contextManager = contextManager;
        this.token = Math.random().toString(36).substring(2, 15);
        this.wss = new ws_1.WebSocketServer({ port, host: '127.0.0.1', maxPayload: 5 * 1024 * 1024 });
        this.wss.on('error', err => onError?.(err));
        this.wss.on('connection', (ws, req) => {
            const origin = req.headers.origin;
            // Permite apenas a origem do chat DeepSeek e extensões do navegador
            if (origin !== 'https://chat.deepseek.com' && !origin?.startsWith('chrome-extension://')) {
                ws.close(1008, 'Origin not allowed');
                return;
            }
            // Estado de cada conexão (cada aba do navegador)
            const pending = new Map(); // alterações de conteúdo ainda não enviadas
            let treeDirty = false; // estrutura de arquivos mudou desde o último envio
            let sentFull = false; // já enviou o contexto completo?
            const subs = [
                this.contextManager.onDidChange(e => { pending.set(e.relPath, e.kind); }),
                this.contextManager.onDidChangeTree(() => { treeDirty = true; })
            ];
            const send = (payload) => {
                if (ws.readyState === ws_1.WebSocket.OPEN)
                    ws.send(JSON.stringify(payload));
            };
            ws.on('message', async (raw) => {
                let msg;
                try {
                    msg = JSON.parse(raw.toString());
                }
                catch {
                    return;
                }
                if (msg.type === 'request') {
                    if (msg.mode === 'full' || !sentFull) {
                        // Primeiro envio (ou reenvio forçado): tree + contexto completo
                        const r = this.contextManager.buildFull();
                        pending.clear();
                        treeDirty = false;
                        sentFull = true;
                        send({
                            type: 'context', mode: 'full', data: r.text,
                            tree: this.contextManager.buildTree(),
                            files: r.files, chars: r.chars, omitted: r.omitted.length
                        });
                    }
                    else {
                        // Próximos envios: só o que mudou (e a tree, se a estrutura mudou)
                        const r = this.contextManager.buildDelta(pending);
                        for (const p of r.included)
                            pending.delete(p);
                        const sendTree = treeDirty;
                        treeDirty = false;
                        send({
                            type: 'context',
                            mode: (r.included.length > 0 || sendTree) ? 'delta' : 'empty',
                            data: r.text,
                            tree: sendTree ? this.contextManager.buildTree() : undefined,
                            files: r.included.length, chars: r.chars, remaining: pending.size
                        });
                    }
                }
                else if (msg.type === 'applyFiles') {
                    if (!this.applyHandler) {
                        send({ type: 'applyResult', status: 'error', message: 'Aplicação não disponível.' });
                        return;
                    }
                    try {
                        const auto = !!msg.autoApply;
                        const runAfter = !!msg.runAfter;
                        const result = await this.applyHandler(msg.files, { auto });
                        // Modo agente: se aplicou, roda e devolve o resultado
                        if (auto && runAfter && result.status === 'applied') {
                            if (this.runner) {
                                const run = await this.runner.run();
                                send({
                                    type: 'applyResult',
                                    ...result,
                                    runSuccess: run.success,
                                    runCommand: run.command,
                                    runOutput: run.output,
                                    runDurationMs: run.durationMs,
                                    runExitCode: run.exitCode,
                                    runVia: run.via
                                });
                            }
                            else {
                                send({
                                    type: 'applyResult',
                                    ...result,
                                    runSuccess: true,
                                    runOutput: '(Sem runner configurado.)'
                                });
                            }
                        }
                        else {
                            send({ type: 'applyResult', ...result });
                        }
                    }
                    catch (e) {
                        send({ type: 'applyResult', status: 'error', message: e instanceof Error ? e.message : String(e) });
                    }
                }
            });
            ws.on('close', () => subs.forEach(s => s.dispose()));
        });
    }
    setApplyHandler(handler) {
        this.applyHandler = handler;
    }
    setRunner(runner) {
        this.runner = runner;
    }
    getToken() {
        return this.token;
    }
    dispose() {
        this.wss.close();
    }
}
exports.WsServer = WsServer;
//# sourceMappingURL=wsServer.js.map