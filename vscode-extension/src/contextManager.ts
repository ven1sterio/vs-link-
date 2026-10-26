import * as vscode from 'vscode';
import * as path from 'path';
import { EXCLUDED_DIRS, isExcludedPath, isProbablyBinary } from './pathRules';

export type ChangeKind = 'changed' | 'deleted';

export interface ChangeEvent {
    relPath: string;
    kind: ChangeKind;
}

export interface FullResult {
    text: string;
    files: number;
    chars: number;
    omitted: string[];
}

export interface DeltaResult {
    text: string;
    included: string[];
    chars: number;
}

const MAX_FILES_SCAN = 20000;
const MAX_TREE_LINES = 2000;

interface TreeNode {
    dirs: Map<string, TreeNode>;
    files: string[];
}

export class ContextManager {
    private files = new Map<string, string>();   // caminho relativo -> conteúdo (texto)
    private allPaths = new Set<string>();         // todos os arquivos visíveis (alimenta a tree)
    private disposables: vscode.Disposable[] = [];

    private readonly _onDidChange = new vscode.EventEmitter<ChangeEvent>();
    private readonly _onDidChangeTree = new vscode.EventEmitter<void>();
    /** Conteúdo de um arquivo mudou ou ele foi removido. */
    readonly onDidChange = this._onDidChange.event;
    /** A estrutura de arquivos mudou (arquivo criado ou removido). */
    readonly onDidChangeTree = this._onDidChangeTree.event;

    constructor(private workspaceRoot: string) {}

    private get maxFileBytes(): number {
        const kb = vscode.workspace.getConfiguration('deepseekContextSync').get<number>('maxFileKB', 300);
        return kb * 1024;
    }

    private get maxTotalChars(): number {
        const kb = vscode.workspace.getConfiguration('deepseekContextSync').get<number>('maxTotalKB', 800);
        return kb * 1024;
    }

    async initialize() {
        const excludeGlob = `{${[...EXCLUDED_DIRS].map(d => `**/${d}/**`).join(',')}}`;
        const uris = await vscode.workspace.findFiles('**/*', excludeGlob, MAX_FILES_SCAN);
        for (const uri of uris) {
            await this.updateFile(uri, false);
        }

        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        watcher.onDidCreate(uri => this.updateFile(uri, true));
        watcher.onDidChange(uri => this.updateFile(uri, true));
        watcher.onDidDelete(uri => this.handleDelete(uri));
        this.disposables.push(watcher, this._onDidChange, this._onDidChangeTree);
    }

    private toRel(uri: vscode.Uri): string | null {
        const rel = path.relative(this.workspaceRoot, uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return rel.split(path.sep).join('/');
    }

    private async updateFile(uri: vscode.Uri, notify: boolean) {
        const rel = this.toRel(uri);
        if (!rel || isExcludedPath(rel)) return;

        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (!(stat.type & vscode.FileType.File)) return; // pasta, etc.

            // A tree mostra TODOS os arquivos visíveis (texto ou binário)
            this.addPath(rel, notify);

            if (stat.size > this.maxFileBytes) {
                this.removeFile(rel, notify);
                return;
            }

            const bytes = await vscode.workspace.fs.readFile(uri);
            if (isProbablyBinary(bytes)) {
                this.removeFile(rel, notify);
                return;
            }

            const content = Buffer.from(bytes).toString('utf8');
            if (this.files.get(rel) === content) return; // nada mudou de fato

            this.files.set(rel, content);
            if (notify) this._onDidChange.fire({ relPath: rel, kind: 'changed' });
        } catch {
            // Ignora arquivos inacessíveis
        }
    }

    private addPath(rel: string, notify: boolean) {
        if (this.allPaths.has(rel)) return;
        this.allPaths.add(rel);
        if (notify) this._onDidChangeTree.fire();
    }

    private removePath(rel: string, notify: boolean) {
        if (this.allPaths.delete(rel) && notify) this._onDidChangeTree.fire();
    }

    private removeFile(rel: string, notify: boolean) {
        if (this.files.delete(rel) && notify) {
            this._onDidChange.fire({ relPath: rel, kind: 'deleted' });
        }
    }

    private handleDelete(uri: vscode.Uri) {
        const rel = this.toRel(uri);
        if (!rel) return;
        this.removeFile(rel, true);
        this.removePath(rel, true);
        // Se foi uma pasta, remove tudo que estava dentro dela
        const prefix = rel + '/';
        for (const key of [...this.files.keys()]) {
            if (key.startsWith(prefix)) this.removeFile(key, true);
        }
        for (const key of [...this.allPaths]) {
            if (key.startsWith(prefix)) this.removePath(key, true);
        }
    }

    /** Estrutura de pastas/arquivos (só nomes) em formato de árvore indentada. */
    buildTree(): string {
        const root: TreeNode = { dirs: new Map(), files: [] };
        for (const p of [...this.allPaths].sort()) {
            const parts = p.split('/');
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                let next = node.dirs.get(parts[i]);
                if (!next) {
                    next = { dirs: new Map(), files: [] };
                    node.dirs.set(parts[i], next);
                }
                node = next;
            }
            node.files.push(parts[parts.length - 1]);
        }

        const lines: string[] = [];
        const render = (node: TreeNode, depth: number) => {
            const indent = '  '.repeat(depth);
            for (const name of [...node.dirs.keys()].sort()) {
                lines.push(`${indent}${name}/`);
                render(node.dirs.get(name)!, depth + 1);
            }
            for (const f of node.files.sort()) lines.push(indent + f);
        };
        render(root, 0);

        if (lines.length === 0) return '(vazio)';
        if (lines.length > MAX_TREE_LINES) {
            const extra = lines.length - MAX_TREE_LINES;
            lines.length = MAX_TREE_LINES;
            lines.push(`[+${extra} itens omitidos]`);
        }
        return lines.join('\n');
    }

    /** Contexto completo (primeiro envio ou reenvio forçado). */
    buildFull(): FullResult {
        const max = this.maxTotalChars;
        let text = '';
        let files = 0;
        const omitted: string[] = [];

        for (const rel of [...this.files.keys()].sort()) {
            const block = `\n--- ${rel} ---\n${this.files.get(rel)}\n`;
            if (text.length + block.length > max) {
                omitted.push(rel);
                continue;
            }
            text += block;
            files++;
        }

        if (omitted.length > 0) {
            text += `\n[Omitidos por limite de tamanho (${omitted.length}): ${omitted.slice(0, 80).join(', ')}]\n`;
            text += `[Aumente "deepseekContextSync.maxTotalKB" nas configurações se precisar enviar mais arquivos.]\n`;
        }
        return { text, files, chars: text.length, omitted };
    }

    /** Apenas o que mudou desde o último envio daquela conexão. */
    buildDelta(pending: Map<string, ChangeKind>): DeltaResult {
        const max = this.maxTotalChars;
        let text = '';
        const included: string[] = [];

        for (const [rel, kind] of pending) {
            const content = this.files.get(rel);
            const block = (kind === 'deleted' || content === undefined)
                ? `\n--- REMOVIDO: ${rel} ---\n`
                : `\n--- ALTERADO: ${rel} ---\n${content}\n`;

            // O que não couber fica pendente para o próximo clique
            if (included.length > 0 && text.length + block.length > max) continue;

            text += block;
            included.push(rel);
        }
        return { text, included, chars: text.length };
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
