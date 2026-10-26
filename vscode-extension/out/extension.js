"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = require("vscode");
const contextManager_1 = require("./contextManager");
const applyManager_1 = require("./applyManager");
const wsServer_1 = require("./wsServer");
const taskRunner_1 = require("./taskRunner");
const pathRules_1 = require("./pathRules");
async function activate(context) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Abra uma pasta de projeto primeiro.');
        return;
    }
    // Precisa vir antes do ContextManager: define se .env e similares entram no contexto
    (0, pathRules_1.setAllowSensitive)(vscode.workspace.getConfiguration('deepseekContextSync').get('allowSensitiveFiles', true));
    const contextManager = new contextManager_1.ContextManager(workspaceRoot);
    await contextManager.initialize();
    const applyManager = new applyManager_1.ApplyManager(workspaceRoot);
    const taskRunner = new taskRunner_1.TaskRunner(workspaceRoot);
    const wsServer = new wsServer_1.WsServer(contextManager, 8765, err => {
        vscode.window.showErrorMessage(`DeepSeek Context Sync: erro no servidor (${err.message}). ` +
            'Se a porta 8765 estiver em uso, feche outras janelas de desenvolvimento.');
    });
    wsServer.setApplyHandler((files, opts) => applyManager.apply(files, opts));
    wsServer.setRunner(taskRunner);
    vscode.window.showInformationMessage(`DeepSeek Context Sync ativo. Token: ${wsServer.getToken()}`);
    context.subscriptions.push(vscode.commands.registerCommand('deepseekContextSync.showToken', () => {
        vscode.window.showInformationMessage(`Token: ${wsServer.getToken()}`);
    }));
    context.subscriptions.push({
        dispose: () => { contextManager.dispose(); applyManager.dispose(); wsServer.dispose(); taskRunner.dispose(); }
    });
}
//# sourceMappingURL=extension.js.map