import * as vscode from 'vscode';
import { ContextManager } from './contextManager';
import { ApplyManager } from './applyManager';
import { WsServer } from './wsServer';
import { TaskRunner } from './taskRunner';
import { setAllowSensitive } from './pathRules';

export async function activate(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Abra uma pasta de projeto primeiro.');
        return;
    }

    // Precisa vir antes do ContextManager: define se .env e similares entram no contexto
    setAllowSensitive(
        vscode.workspace.getConfiguration('deepseekContextSync').get<boolean>('allowSensitiveFiles', true)
    );

    const contextManager = new ContextManager(workspaceRoot);
    await contextManager.initialize();

    const applyManager = new ApplyManager(workspaceRoot);
    const taskRunner = new TaskRunner(workspaceRoot);

    const wsServer = new WsServer(contextManager, 8765, err => {
        vscode.window.showErrorMessage(
            `DeepSeek Context Sync: erro no servidor (${err.message}). ` +
            'Se a porta 8765 estiver em uso, feche outras janelas de desenvolvimento.'
        );
    });
    wsServer.setApplyHandler((files, opts) => applyManager.apply(files, opts));
    wsServer.setRunner(taskRunner);

    vscode.window.showInformationMessage(`DeepSeek Context Sync ativo. Token: ${wsServer.getToken()}`);

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.showToken', () => {
            vscode.window.showInformationMessage(`Token: ${wsServer.getToken()}`);
        })
    );

    context.subscriptions.push({
        dispose: () => { contextManager.dispose(); applyManager.dispose(); wsServer.dispose(); taskRunner.dispose(); }
    });
}
