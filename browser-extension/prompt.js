// Montagem do prompt enviado ao DeepSeek.
// Contrato de resposta: um bloco "### FILE: caminho" por arquivo, sempre com o arquivo COMPLETO.

const FENCE = '`'.repeat(3);
const PROMPT_MARKER = '[PERGUNTA]';

const RESPONSE_RULES = [
    '[INSTRUÇÕES — SIGA ESTRITAMENTE]',
    'Você é um assistente de código integrado a um projeto real no VS Code.',
    'Quando precisar alterar ou criar arquivos, responda EXATAMENTE neste formato, um bloco por arquivo:',
    '',
    '### FILE: caminho/do/arquivo.ext',
    FENCE + 'linguagem',
    '<conteúdo COMPLETO do arquivo, do início ao fim>',
    FENCE,
    '',
    'Regras obrigatórias:',
    '1. Sempre devolva o ARQUIVO INTEIRO, nunca trechos nem diffs.',
    '2. Nunca escreva frases como "adicione ao final", "substitua a linha X" ou "resto igual".',
    '3. Nunca use "..." nem "<resto do código>" no lugar de código existente.',
    '4. Use apenas caminhos da estrutura abaixo (relativos à raiz do projeto). Só crie arquivos novos se eu pedir.',
    '5. Se precisar alterar 2 arquivos, emita DOIS blocos "### FILE:" separados.',
    '6. Se a pergunta não exigir alterar arquivos, responda normalmente, sem blocos "### FILE:".',
    '7. Fora dos blocos pode haver uma explicação curta; o código vai somente dentro dos blocos.',
    '',
    'Exemplo (apenas ilustrativo): se main.py contém print("hello world") e eu pedir',
    '"adicione o print: ola mundo", a resposta correta é:',
    '',
    '### FILE: main.py',
    FENCE + 'python',
    'print("hello world")',
    'print("ola mundo")',
    FENCE,
    '',
    '(e NÃO uma frase como "adicione ao final do arquivo: print(\\"ola mundo\\")").'
].join('\n');

const DELTA_REMINDER =
    'Mantenha as mesmas regras: ao alterar arquivos, responda com "### FILE: caminho" seguido do ' +
    'arquivo COMPLETO em bloco de código, sem trechos e sem "...".';

// ---------------------------------------------------------------------------
// Modo Full Code (agente autônomo)
// ---------------------------------------------------------------------------
// Marcadores que o agente usa para saber (1) que a resposta terminou e (2) se há mais etapas.
// Texto simples, sem "<>" nem "===", para o Markdown do site não "comer" nem transformar.
const END_MARKER = '[[FIM-DA-RESPOSTA]]';
const STATUS_CONTINUE = '[[STATUS:CONTINUAR]]';
const STATUS_DONE = '[[STATUS:CONCLUIDO]]';

const FULL_CODE_RULES = [
    '',
    '[MODO FULL CODE — AGENTE AUTÔNOMO]',
    'Você vai desenvolver a APLICAÇÃO INTEIRA sozinho, a partir do meu único pedido abaixo.',
    'Não me faça perguntas, NUNCA peça confirmação nem permissão para continuar (nada de "deseja continuar?"):',
    'decida o que for preciso e siga em frente até a aplicação estar completa.',
    '',
    'COMO O CICLO FUNCIONA:',
    '1. Você responde com arquivos \"### FILE:\" (completos).',
    '2. O sistema grava os arquivos no projeto, instala dependências e executa build/testes.',
    '3. O sistema te devolve o resultado (sucesso ou o erro completo) como próxima mensagem.',
    '4. Se deu erro, corrija. Se deu certo, siga para a PRÓXIMA ETAPA do plano. Repete até terminar.',
    '',
    'PLANEJAMENTO:',
    '- Na PRIMEIRA resposta, escreva um plano curto numerado (3 a 10 etapas) e já implemente a etapa 1.',
    '- Cada resposta implementa UMA etapa. Prefira etapas pequenas (até ~8 arquivos e ~600 linhas',
    '  no total por resposta) — respostas muito longas são cortadas pelo site e se perdem.',
    '- Ordem sugerida: estrutura/config e dependências -> núcleo/lógica -> interface -> testes/ajustes finais.',
    '- Inclua em package.json (ou equivalente) um script \"build\" ou \"test\" que valide o projeto, para o sistema',
    '  conseguir verificar o código a cada etapa. Se precisar de variáveis de ambiente, crie o arquivo .env.',
    '',
    'LIMITES:',
    '- No máximo 20 arquivos \"### FILE:\" por resposta; acima disso a aplicação é rejeitada.',
    '- Sempre reenvie o arquivo COMPLETO, mesmo em correção pequena. O histórico da conversa é a fonte de verdade.',
    '',
    'REGRAS DE FORMATO DO FINAL DA RESPOSTA (OBRIGATÓRIAS, TODA RESPOSTA):',
    '- A penúltima linha deve ser exatamente ' + STATUS_CONTINUE + ' se ainda restam etapas,',
    '  ou ' + STATUS_DONE + ' somente quando a aplicação estiver COMPLETA e funcionando.',
    '- A última linha deve ser exatamente ' + END_MARKER + ' (o sistema usa isso para saber que você terminou).',
    '- Sem nada depois dessa última linha.'
].join('\n');

/** Primeiro envio (ou reenvio forçado): regras + tree + todos os arquivos + pergunta. */
function buildFullPrompt({ tree, context, question, fullCode }) {
    const parts = [
        RESPONSE_RULES,
        fullCode ? FULL_CODE_RULES : '',
        '',
        'Estrutura do projeto:',
        FENCE,
        tree || '(vazio)',
        FENCE,
        '',
        '---',
        '',
        '[CONTEXTO ATUAL DOS ARQUIVOS]',
        context,
        '---',
        '',
        PROMPT_MARKER,
        question
    ];
    return parts.join('\n');
}

/** Envios seguintes: lembrete + (tree, se mudou) + só o que mudou + pergunta. */
function buildDeltaPrompt({ tree, changes, question, fullCode }) {
    const parts = ['[ATUALIZAÇÃO DO PROJETO]', DELTA_REMINDER, ''];

    if (fullCode) parts.push(FULL_CODE_RULES, '');

    if (tree) {
        parts.push('A estrutura do projeto mudou. Estrutura atual:', FENCE, tree, FENCE, '');
    }
    if (changes && changes.trim()) {
        parts.push(
            'Arquivos alterados ou removidos desde o contexto anterior desta conversa:',
            changes,
            '---',
            ''
        );
    }
    parts.push(PROMPT_MARKER, question);
    return parts.join('\n');
}
