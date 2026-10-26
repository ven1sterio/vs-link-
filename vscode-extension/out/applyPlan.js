"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_APPLY_FILE_CHARS = exports.MAX_APPLY_FILES = void 0;
exports.planFiles = planFiles;
exports.countLines = countLines;
exports.isSuspiciousShrink = isSuspiciousShrink;
const path = require("path");
const pathRules_1 = require("./pathRules");
exports.MAX_APPLY_FILES = 20;
exports.MAX_APPLY_FILE_CHARS = 500000;
const fail = (error) => ({ ok: false, error });
/** Valida o que veio do navegador. O navegador não é confiável: tudo é checado aqui. */
function planFiles(input, root) {
    if (!Array.isArray(input) || input.length === 0)
        return fail('Nenhum arquivo recebido.');
    if (input.length > exports.MAX_APPLY_FILES)
        return fail(`Arquivos demais (máximo ${exports.MAX_APPLY_FILES}).`);
    const byRel = new Map();
    for (const item of input) {
        if (!item || typeof item.filePath !== 'string' || typeof item.content !== 'string') {
            return fail('Formato de arquivo inválido.');
        }
        if (item.content.length > exports.MAX_APPLY_FILE_CHARS) {
            return fail(`${item.filePath}: arquivo grande demais (máximo ${exports.MAX_APPLY_FILE_CHARS} caracteres).`);
        }
        const raw = item.filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
        if (!raw || raw.includes('\0') || raw.endsWith('/'))
            return fail(`Caminho inválido: "${item.filePath}"`);
        if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw))
            return fail(`Caminho absoluto não permitido: ${raw}`);
        if (raw.split('/').some(seg => seg === '..'))
            return fail(`Caminho fora do projeto: ${raw}`);
        const abs = path.resolve(root, raw);
        const check = path.relative(root, abs);
        if (!check || check.startsWith('..') || path.isAbsolute(check)) {
            return fail(`Caminho fora do projeto: ${raw}`);
        }
        const rel = check.split(path.sep).join('/');
        if ((0, pathRules_1.isExcludedPathForWrite)(rel))
            return fail(`Caminho protegido (não pode ser alterado pelo chat): ${rel}`);
        byRel.set(rel, { rel, abs, content: item.content }); // se repetir, vale o último
    }
    return { ok: true, files: [...byRel.values()] };
}
function countLines(text) {
    if (text === '')
        return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
/** Arquivo grande que "encolheu" muito: sinal típico de trecho omitido pelo modelo. */
function isSuspiciousShrink(oldLines, newLines) {
    return oldLines >= 20 && newLines < oldLines * 0.6;
}
//# sourceMappingURL=applyPlan.js.map