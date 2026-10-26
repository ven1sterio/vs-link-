"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplyManager = void 0;
const vscode = require("vscode");
const path = require("path");
const applyPlan_1 = require("./applyPlan");
const pathRules_1 = require("./pathRules");
const SCHEME = 'deepseek-proposed';
/**
 * Recebe os arquivos completos devolvidos pelo chat, mostra um resumo (e, se o usuário
 * quiser, o diff) e só grava depois da confirmação explícita.
 * Também serve o conteúdo "proposto" para a tela de diff.
 *
 * No modo `auto` (Full Code), pula o diálogo e escreve direto.
 */
class ApplyManager {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.proposals = new Map();
        this.busy = false;
        this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
    }
    provideTextDocumentContent(uri) {
        return this.proposals.get(uri.path) ?? '';
    }
    async apply(input, options = {}) {
        if (this.busy) {
            return { status: 'error', message: 'Já existe uma aplicação aguardando confirmação no VS Code.' };
        }
        const plan = (0, applyPlan_1.planFiles)(input, this.workspaceRoot);
        if (!plan.ok)
            return { status: 'error', message: plan.error };
        this.busy = true;
        this.proposals.clear();
        try {
            const entries = await this.inspect(plan.files);
            if (options.auto) {
                return await this.write(entries);
            }
            let choice = await vscode.window.showWarningMessage(`Aplicar alterações do DeepSeek em ${entries.length} arquivo(s)?`, { modal: true, detail: this.describe(entries) }, 'Aplicar', 'Revisar diff primeiro');
            if (choice === 'Revisar diff primeiro') {
                await this.openDiffs(entries);
                choice = await vscode.window.showInformationMessage('Revise o diff nas abas abertas. Aplicar as alterações?', 'Aplicar', 'Cancelar');
            }
            if (choice !== 'Aplicar') {
                return { status: 'cancelled', message: 'Alteração cancelada.' };
            }
            return await this.write(entries);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { status: 'error', message };
        }
        finally {
            this.busy = false;
        }
    }
    async inspect(files) {
        const entries = [];
        for (const file of files) {
            const uri = vscode.Uri.file(file.abs);
            let stat;
            try {
                stat = await vscode.workspace.fs.stat(uri);
            }
            catch {
                stat = undefined;
            }
            if (stat && (stat.type & vscode.FileType.Directory)) {
                throw new Error(`${file.rel} é uma pasta.`);
            }
            let doc;
            if (stat) {
                try {
                    doc = await vscode.workspace.openTextDocument(uri);
                }
                catch {
                    throw new Error(`Não foi possível abrir ${file.rel} como texto.`);
                }
            }
            entries.push({
                file, uri, doc,
                oldLines: doc ? (0, applyPlan_1.countLines)(doc.getText()) : 0,
                newLines: (0, applyPlan_1.countLines)(file.content)
            });
        }
        return entries;
    }
    describe(entries) {
        return entries.map(e => {
            if (!e.doc)
                return `• ${e.file.rel} — NOVO (${e.newLines} linhas)`;
            let line = `• ${e.file.rel} — ${e.oldLines} → ${e.newLines} linhas`;
            const name = e.file.rel.split('/').pop() ?? '';
            if ((0, pathRules_1.looksSensitive)(name)) {
                line += '\n    ⚠️ arquivo sensível (pode conter segredos): confira o diff';
            }
            if ((0, applyPlan_1.isSuspiciousShrink)(e.oldLines, e.newLines)) {
                line += '\n    ⚠️ o arquivo encolheu muito: o modelo pode ter omitido trechos';
            }
            if (e.doc.isDirty) {
                line += '\n    ⚠️ há alterações não salvas no editor que serão substituídas';
            }
            return line;
        }).join('\n');
    }
    async openDiffs(entries) {
        for (const e of entries) {
            const right = vscode.Uri.from({ scheme: SCHEME, path: '/proposed/' + e.file.rel });
            const left = e.doc ? e.uri : vscode.Uri.from({ scheme: SCHEME, path: '/empty' });
            this.proposals.set(right.path, e.file.content);
            await vscode.commands.executeCommand('vscode.diff', left, right, `${e.file.rel} ↔ DeepSeek`, { preview: false });
        }
    }
    async write(entries) {
        const edit = new vscode.WorkspaceEdit();
        for (const e of entries) {
            if (e.doc) {
                const full = new vscode.Range(e.doc.positionAt(0), e.doc.positionAt(e.doc.getText().length));
                edit.replace(e.uri, full, e.file.content);
            }
            else {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(e.file.abs)));
                edit.createFile(e.uri, { ignoreIfExists: true });
                edit.insert(e.uri, new vscode.Position(0, 0), e.file.content);
            }
        }
        // Uma única edição para todos os arquivos; desfazer (Ctrl+Z) continua disponível
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok)
            return { status: 'error', message: 'O VS Code recusou a edição.' };
        for (const e of entries) {
            const doc = await vscode.workspace.openTextDocument(e.uri);
            if (doc.isDirty)
                await doc.save();
        }
        const names = entries.map(e => e.file.rel);
        const shown = names.length <= 3
            ? names.join(', ')
            : `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
        vscode.window.showInformationMessage(`✅ DeepSeek: ${names.length} arquivo(s) atualizado(s): ${shown}`);
        return { status: 'applied', message: `${names.length} arquivo(s) atualizado(s).`, files: names };
    }
    dispose() {
        this.registration.dispose();
    }
}
exports.ApplyManager = ApplyManager;
//# sourceMappingURL=applyManager.js.map