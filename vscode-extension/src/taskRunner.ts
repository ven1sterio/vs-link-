import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export interface RunResult {
    success: boolean;
    command: string;
    output: string;
    durationMs: number;
    exitCode?: number | null;
    via?: 'terminal' | 'process' | 'none';
}

interface StepResult {
    success: boolean;
    output: string;
    exitCode: number | null;
}

const MAX_OUTPUT = 50_000;
// PowerShell com ExecutionPolicy restrita bloqueia npm.ps1; nesse caso rodamos pelo cmd (processo).
const POLICY_BLOCK_RE = /running scripts is disabled|PSSecurityException|UnauthorizedAccess|execu[cç][aã]o de scripts foi desabilitada/i;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Remove códigos de cor/controle do terminal e resolve \r (barras de progresso). */
function cleanTerminalText(raw: string): string {
    const s = raw
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/\u001b[()][A-Z0-9]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => (c === '\r' ? '\r' : ''));
    return s.split('\n').map(line => {
        const i = line.lastIndexOf('\r');
        return i >= 0 ? line.slice(i + 1) : line;
    }).join('\n');
}

function truncateHead(text: string): string {
    return text.length > MAX_OUTPUT ? '[...início truncado...]\n' + text.slice(-MAX_OUTPUT) : text;
}

/**
 * Executa o "build/test" do projeto para o agente Full Code verificar se o código funciona.
 *
 * Preferência de execução:
 *   1. Terminal integrado do VS Code (aba "DeepSeek Agent"): você vê o comando rodando ao vivo.
 *      Usa a API de shell integration para capturar a saída e o código de saída.
 *   2. Processo em segundo plano (fallback automático: sem shell integration, PowerShell bloqueando
 *      scripts, ou código de saída indisponível). A saída também aparece no painel "DeepSeek Agent".
 *
 * Comando: deepseekContextSync.runCommand, ou auto-detecção (npm install se faltar + build/test, etc.).
 * Comandos com "&&" são executados um por vez (funciona em PowerShell 5, que não aceita "&&").
 */
export class TaskRunner implements vscode.Disposable {
    private terminal?: vscode.Terminal;
    private channel: vscode.OutputChannel;
    private closeSub: vscode.Disposable;

    constructor(private workspaceRoot: string) {
        this.channel = vscode.window.createOutputChannel('DeepSeek Agent');
        this.closeSub = vscode.window.onDidCloseTerminal(t => {
            if (t === this.terminal) this.terminal = undefined;
        });
    }

    dispose() {
        this.closeSub.dispose();
        this.channel.dispose();
        this.terminal?.dispose();
    }

    // ---------- Descoberta do comando ----------

    private resolveSteps(): string[] | null {
        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
        const explicit = cfg.get<string>('runCommand', '').trim();
        if (explicit) return explicit.split(/\s*&&\s*/).filter(Boolean);

        try {
            const pkgPath = path.join(this.workspaceRoot, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                const scripts = pkg && pkg.scripts ? pkg.scripts : {};
                const steps: string[] = [];
                if (this.needsNpmInstall(pkgPath, pkg)) steps.push('npm install --no-audit --no-fund');
                if (scripts.build) steps.push('npm run build');
                else if (scripts.check) steps.push('npm run check');
                else if (scripts.test) steps.push('npm test');
                else if (scripts.compile) steps.push('npm run compile');
                return steps.length > 0 ? steps : null;
            }

            if (fs.existsSync(path.join(this.workspaceRoot, 'Cargo.toml'))) return ['cargo check'];
            if (fs.existsSync(path.join(this.workspaceRoot, 'go.mod'))) return ['go build ./...'];

            const hasPyProject = fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'));
            const hasReqTxt = fs.existsSync(path.join(this.workspaceRoot, 'requirements.txt'));
            if (hasPyProject || hasReqTxt) {
                const hasPytest = fs.existsSync(path.join(this.workspaceRoot, 'pytest.ini'))
                    || fs.existsSync(path.join(this.workspaceRoot, 'tests'));
                return [hasPytest ? 'python -m pytest -q' : 'python -m compileall -q .'];
            }
        } catch {
            // ignora e tenta seguir
        }
        return null;
    }

    /** Instala dependências se o projeto (recém-gerado) ainda não tem node_modules atualizado. */
    private needsNpmInstall(pkgPath: string, pkg: any): boolean {
        const hasDeps = Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length > 0;
        if (!hasDeps) return false;
        const nm = path.join(this.workspaceRoot, 'node_modules');
        if (!fs.existsSync(nm)) return true;
        try {
            return fs.statSync(pkgPath).mtimeMs > fs.statSync(nm).mtimeMs;
        } catch {
            return false;
        }
    }

    private childEnv(): NodeJS.ProcessEnv {
        return {
            CI: '1', FORCE_COLOR: '0', NO_COLOR: '1',
            NEXT_TELEMETRY_DISABLED: '1', npm_config_yes: 'true', ADBLOCK: '1'
        };
    }

    // ---------- Execução ----------

    async run(): Promise<RunResult> {
        const steps = this.resolveSteps();
        if (!steps) {
            return {
                success: true, command: '', durationMs: 0, via: 'none',
                output: '(Nenhum comando de execução configurado nem detectado. Configure "deepseekContextSync.runCommand" para que o agente possa validar o código.)'
            };
        }

        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
        const totalMs = Math.max(5, cfg.get<number>('runTimeoutSec', 600)) * 1000;
        const useTerminal = cfg.get<boolean>('runInTerminal', true);
        const command = steps.join(' && ');
        const start = Date.now();
        let log = '';
        let via: 'terminal' | 'process' = 'process';

        this.channel.appendLine(`\n=== ${new Date().toLocaleTimeString()}  ${command}  (pasta: ${this.workspaceRoot}) ===`);

        for (const step of steps) {
            const remaining = totalMs - (Date.now() - start);
            if (remaining <= 0) {
                log += `\n[Tempo total esgotado após ${totalMs / 1000}s]`;
                return this.finish(false, command, log, start, null, via);
            }

            let r: StepResult | null = null;
            if (useTerminal) {
                r = await this.runStepInTerminal(step, remaining);
                if (r && !r.success && POLICY_BLOCK_RE.test(r.output)) {
                    this.channel.appendLine('(PowerShell bloqueou scripts; repetindo pelo processo em segundo plano)');
                    r = null;
                }
                if (r) via = 'terminal';
            }
            if (!r) {
                via = 'process';
                r = await this.runStepSpawn(step, Math.max(5000, totalMs - (Date.now() - start)));
            }

            log += `$ ${step}\n${r.output}\n`;
            this.channel.appendLine(`[${step}] terminou com código ${r.exitCode}`);

            if (!r.success) {
                return this.finish(false, command, log, start, r.exitCode, via);
            }
        }
        return this.finish(true, command, log, start, 0, via);
    }

    private finish(success: boolean, command: string, log: string, start: number,
                   exitCode: number | null, via: 'terminal' | 'process'): RunResult {
        let output = truncateHead(log.trim());
        if (!success) {
            const meaningful = output.split('\n')
                .filter(l => l.trim() && !/^>\s/.test(l.trim()) && !/^\$\s/.test(l.trim())).length;
            const header = `[Falhou com código de saída ${exitCode ?? 'desconhecido'} | pasta: ${this.workspaceRoot}]\n`;
            const hint = meaningful === 0
                ? '\n[O comando falhou mas não imprimiu detalhes do erro. Verifique o painel "DeepSeek Agent" ' +
                  '(Saída) / terminal do VS Code. Causas comuns: dependência faltando, script "build" inexistente ou erro de configuração.]'
                : '';
            output = header + output + hint;
        }
        return { success, command, output, durationMs: Date.now() - start, exitCode, via };
    }

    private ensureTerminal(): vscode.Terminal {
        if (!this.terminal || this.terminal.exitStatus !== undefined) {
            this.terminal = vscode.window.createTerminal({
                name: 'DeepSeek Agent',
                cwd: this.workspaceRoot,
                env: this.childEnv() as { [key: string]: string }
            });
        }
        return this.terminal;
    }

    /** Roda no terminal integrado (shell integration). Retorna null se não for possível. */
    private async runStepInTerminal(step: string, timeoutMs: number): Promise<StepResult | null> {
        const w = vscode.window as any;
        if (typeof w.onDidEndTerminalShellExecution !== 'function') return null; // VS Code antigo

        try {
            const term = this.ensureTerminal();
            term.show(true);

            let si: any = (term as any).shellIntegration;
            if (!si && typeof w.onDidChangeTerminalShellIntegration === 'function') {
                si = await new Promise<any>(resolve => {
                    const timer = setTimeout(() => { sub.dispose(); resolve((term as any).shellIntegration); }, 10000);
                    const sub = w.onDidChangeTerminalShellIntegration((e: any) => {
                        if (e.terminal === term) { clearTimeout(timer); sub.dispose(); resolve(e.shellIntegration); }
                    });
                    if ((term as any).shellIntegration) {
                        clearTimeout(timer); sub.dispose(); resolve((term as any).shellIntegration);
                    }
                });
            }
            if (!si) return null; // sem shell integration (ex.: cmd.exe)

            let exec: any;
            let exitCode: number | undefined;
            let endResolve: () => void = () => { /* definido abaixo */ };
            const endPromise = new Promise<void>(r => { endResolve = r; });
            const endSub = w.onDidEndTerminalShellExecution((e: any) => {
                if (exec && e.execution === exec) { exitCode = e.exitCode; endResolve(); }
            });

            exec = si.executeCommand(step);

            let raw = '';
            const reader = (async () => {
                try {
                    for await (const chunk of exec.read()) {
                        raw += chunk;
                        if (raw.length > MAX_OUTPUT * 2) raw = raw.slice(-MAX_OUTPUT * 2);
                    }
                } catch { /* fim do fluxo */ }
            })();

            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                try { term.sendText('\u0003', false); } catch { /* ignore */ }
                endResolve();
            }, timeoutMs);

            await endPromise;
            clearTimeout(timer);
            await Promise.race([reader, sleep(1500)]);
            endSub.dispose();

            const output = cleanTerminalText(raw).trim();
            this.channel.appendLine(output);

            if (timedOut) {
                return { success: false, exitCode: null, output: output + `\n[Tempo esgotado após ${Math.round(timeoutMs / 1000)}s; comando interrompido]` };
            }
            if (exitCode === undefined) return null; // não deu para saber; refaz pelo processo
            return { success: exitCode === 0, exitCode, output };
        } catch {
            return null;
        }
    }

    /** Fallback: processo em segundo plano (stdin fechado, para nenhum prompt interativo travar). */
    private runStepSpawn(step: string, timeoutMs: number): Promise<StepResult> {
        return new Promise<StepResult>(resolve => {
            let output = '';
            let killed = false;
            let child;
            try {
                child = spawn(step, [], {
                    cwd: this.workspaceRoot,
                    shell: true,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, ...this.childEnv() }
                });
            } catch (e) {
                resolve({ success: false, exitCode: null, output: 'Falha ao iniciar o comando: ' + (e instanceof Error ? e.message : String(e)) });
                return;
            }

            const append = (buf: Buffer) => {
                const text = buf.toString('utf8');
                this.channel.append(text);
                output += text;
                if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
            };
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);

            const timer = setTimeout(() => {
                killed = true;
                try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }, timeoutMs);

            child.on('error', err => {
                clearTimeout(timer);
                resolve({ success: false, exitCode: null, output: cleanTerminalText(output) + '\n[erro de execução: ' + err.message + ']' });
            });

            child.on('close', code => {
                clearTimeout(timer);
                let text = cleanTerminalText(output).trim();
                if (killed) text += `\n[Tempo esgotado após ${Math.round(timeoutMs / 1000)}s]`;
                resolve({ success: code === 0 && !killed, exitCode: code, output: text });
            });
        });
    }
}
