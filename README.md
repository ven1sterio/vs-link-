# DeepSeek Context Sync

Envia o contexto do seu projeto do VS Code para o chat web do DeepSeek e aplica
de volta no VS Code os arquivos que ele devolver.

Tem dois modos de operação:

- **Manual**: você envia o contexto, conversa com o DeepSeek e clica em "Aplicar resposta"
  para revisar/confirmar cada alteração no VS Code.
- **Full Code (agente autônomo)**: o ciclo *enviar → receber → aplicar → executar → corrigir*
  acontece automaticamente até o código rodar ou o limite de iterações ser atingido.

## Estrutura

```
deepseek-context-sync/
├── browser-extension/   # Extensão do navegador (chat.deepseek.com): botões, prompt, parser e agente
│   ├── manifest.json
│   ├── prompt.js        # Monta os prompts (contexto completo, alterações, regras do Full Code)
│   ├── parser.js        # Lê a resposta do modelo e extrai os arquivos (FILE: caminho)
│   └── content.js       # UI, conexão com o VS Code e loop do agente
└── vscode-extension/    # Extensão do VS Code (servidor WebSocket local)
    └── src/
        ├── extension.ts       # Ativação e ligação dos módulos
        ├── contextManager.ts  # Varre o projeto, monta tree/contexto/deltas
        ├── pathRules.ts       # Pastas excluídas, tipos de arquivo, binários, arquivos sensíveis
        ├── applyPlan.ts       # Valida os arquivos devolvidos pelo modelo
        ├── applyManager.ts    # Aplica os arquivos (com confirmação ou automático)
        ├── taskRunner.ts      # Executa build/testes (terminal integrado ou segundo plano)
        └── wsServer.ts        # Comunicação com a extensão do navegador
```

## Full Code (um único prompt)

1. Ative **🔁 Full Code**, escreva o pedido (ex.: "crie uma API de tarefas em Node com testes") e clique em **🚀 Rodar agente**.
2. O modelo faz um plano em etapas e, a cada resposta, implementa uma etapa. O agente aplica os arquivos,
   instala dependências, executa o build/testes e devolve o resultado. Se falhar, ele corrige; se passar, pede a próxima etapa.
3. Termina quando o modelo responde `[[STATUS:CONCLUIDO]]`, quando não envia arquivos, ou após 40 iterações
   (`MAX_AGENT_ITERATIONS` em `content.js`). Para parar antes, clique em **⏹ Parar agente**.
4. Recomendado: em uma conversa NOVA do DeepSeek, clique antes em **🔄 Contexto completo**.

## Contexto enviado ao chat

- **Limites padrão**: `deepseekContextSync.maxFileKB = 300` (por arquivo) e `deepseekContextSync.maxTotalKB = 800` (por envio).
  O que exceder o total é omitido (contexto completo) ou fica para o próximo clique (alterações), e a lista dos omitidos
  aparece no próprio contexto com um aviso para aumentar o limite.
- **Detecção de binários**: em vez de depender só da extensão, a extensão lê os primeiros 8 KB do arquivo e descarta
  o que parece binário (byte nulo ou mais de 30% de controles). Assim imagens, PDFs e executáveis ficam de fora,
  mas SVG, `.env`, `.lock` e arquivos sem extensão conhecida entram normalmente.
- **Tree completa**: todos os arquivos visíveis aparecem na tree (até 20.000 arquivos varridos e 2.000 linhas),
  mesmo os que não têm o conteúdo enviado.
- **Pastas ignoradas** (não entram no contexto, na tree, no watcher nem podem ser escritas pelo chat):
  `node_modules`, `.git`, `dist`, `out`, `build`, `.next`, `.nuxt`, `.vscode`, `.idea`, `__pycache__`, `.venv`, `venv`,
  `coverage`, `target`, caches de frameworks (`.turbo`, `.vercel`, `.cache`, `.parcel-cache`, `.swc`, `.svelte-kit`,
  `.angular`, `.docusaurus`, `.expo`, `.gradle`, `.mvn`, `.yarn`, `bower_components`, `tmp`, `temp`) e pastas de
  ferramentas de IA (`.agents`, `.claude`, `.windsurf`, `.cursor`, `.continue`, `.aider`).

## Arquivos sensíveis (.env, chaves)

Por padrão (`deepseekContextSync.allowSensitiveFiles = true`) `.env`, `.env.*`, `*.pem`, `*.key` etc. **não são
bloqueados**: o conteúdo é enviado ao chat e o agente pode criá-los e editá-los. Desligue a opção (e recarregue a janela
do VS Code) para voltar ao bloqueio. Com a opção desligada, `.env.local` continua podendo ser criado/alterado pelo chat
(o conteúdo atual dele nunca é enviado; confira o diff antes de aplicar).

Templates como `.env.example`, `.env.sample`, `.env.template` e `.env.dist` nunca são tratados como sensíveis,
pois não contêm segredos reais.

## Execução (build/testes) no terminal integrado

Após aplicar os arquivos, o agente executa o build no **terminal integrado** do VS Code (aba **DeepSeek Agent**), onde você
acompanha ao vivo. A saída e o código de saída voltam ao chat do DeepSeek quando algo falha.

- Detecta o comando sozinho: `npm install` (se faltar/estiver desatualizado) + `npm run build` / `check` / `test`; Cargo, Go e Python também.
- Para fixar outro comando: `deepseekContextSync.runCommand` (use `&&` para encadear; cada passo roda separado).
- `deepseekContextSync.runInTerminal = false` força processo em segundo plano (a saída aparece em *Saída → DeepSeek Agent*).
- Fallback automático para processo em segundo plano se o terminal não tiver shell integration (ex.: cmd.exe) ou se o PowerShell bloquear scripts.
- Timeout padrão: 600 s (`deepseekContextSync.runTimeoutSec`).

## Respostas cortadas / "Continuar"

Quando o site corta a resposta e mostra o botão **Continuar**, o agente clica sozinho. Se o modelo escrever "deseja continuar?"
em texto, o agente responde "continue" sozinho. O prompt também manda o modelo trabalhar em etapas pequenas.

## Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `deepseekContextSync.maxFileKB` | 300 | Tamanho máximo (KB) de cada arquivo |
| `deepseekContextSync.maxTotalKB` | 800 | Tamanho máximo (KB) de cada envio ao chat |
| `deepseekContextSync.runCommand` | vazio | Comando do Full Code (vazio = auto-detectar) |
| `deepseekContextSync.runTimeoutSec` | 600 | Timeout do comando de execução |
| `deepseekContextSync.allowSensitiveFiles` | true | Libera `.env`, chaves e credenciais |
| `deepseekContextSync.runInTerminal` | true | Executa no terminal integrado do VS Code |

## Script: limpar skills duplicadas e aumentar o limite de contexto

Salve como `limpar-contexto.ps1` e rode na raiz do projeto que você sincroniza. Ele move `.agents`, `.claude` e
`.windsurf` para um backup fora do projeto e atualiza `deepseekContextSync.maxTotalKB` no `settings.json` do VS Code.

```powershell
param(
    [string]$ProjectRoot = (Get-Location).Path,
    [ValidateSet(".agents", ".claude", ".windsurf", "all")]
    [string]$Remove = "all",
    [int]$MaxTotalKB = 1500
)

$ErrorActionPreference = "Stop"
Write-Host "Projeto: $ProjectRoot" -ForegroundColor Cyan

# --- 1) Move skills duplicadas para FORA do projeto ---
$backupDir = Join-Path (Split-Path $ProjectRoot -Parent) ("backup_skills" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$toMove = if ($Remove -eq "all") { @(".agents", ".claude", ".windsurf") } else { @($Remove) }

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$moved = 0
foreach ($d in $toMove) {
    $src = Join-Path $ProjectRoot $d
    if (Test-Path $src) {
        $sizeKB = [math]::Round((Get-ChildItem $src -Recurse -File |
                                 Measure-Object Length -Sum).Sum / 1KB, 1)
        Move-Item -Path $src -Destination (Join-Path $backupDir $d)
        Write-Host "Movido: $d ($sizeKB KB liberados)" -ForegroundColor Yellow
        $moved++
    } else {
        Write-Host "Ignorado (não existe): $d"
    }
}

if ($moved -eq 0) {
    Write-Host "Nada para mover." -ForegroundColor Yellow
} else {
    Write-Host "Backup em: $backupDir" -ForegroundColor Green
}

# --- 2) Atualiza settings.json do VS Code ---
$settingsPaths = @(
    (Join-Path $env:APPDATA "Code\User\settings.json"),
    (Join-Path $env:APPDATA "Code - Insiders\User\settings.json")
) | Where-Object { Test-Path $_ }

if ($settingsPaths.Count -eq 0) {
    Write-Warning "settings.json do VS Code nao encontrado. Edite manualmente:"
    Write-Host "  ""deepseekContextSync.maxTotalKB"": $MaxTotalKB"
    exit
}

foreach ($sp in $settingsPaths) {
    $bak = "$sp.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item $sp $bak

    $text = [System.IO.File]::ReadAllText($sp)
    $pattern = '("deepseekContextSync\.maxTotalKB"\s*:\s*)\d+'

    if ($text -match $pattern) {
        # Chave ja existe -> substitui valor
        $text = $text -replace $pattern, ('${1}' + $MaxTotalKB)
    } else {
        # Chave ausente -> insere antes do ultimo }
        $idx = $text.LastIndexOf('}')
        if ($idx -ge 0) {
            $before = $text.Substring(0, $idx).TrimEnd()
            $after  = $text.Substring($idx)

            $needsComma = -not ($before.EndsWith('{') -or $before.EndsWith(','))
            $comma = if ($needsComma) { ',' } else { '' }

            $insert = @"
$comma
    "deepseekContextSync.maxTotalKB": $MaxTotalKB
"@
            $text = $before + $insert + $after
        }
    }

    [System.IO.File]::WriteAllText($sp, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Atualizado: $sp (backup: $bak)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Pronto. Recarregue a aba do chat (F5) e clique em 'Contexto completo'." -ForegroundColor Cyan
```
