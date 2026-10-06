// Resolve diretórios de dados do projeto (public/, migrations/) sem depender de onde o arquivo
// executável acabou. Rodando pelo Node, `import.meta.url` aponta para src/ e o pai é a raiz do
// projeto. Num deploy serverless o código é empacotado: o bundle fica em outro lugar e
// `import.meta.url` pode apontar para ele — ou nem existir, se o empacotador converter para CJS.
//
// Por isso: tenta os candidatos em ordem e devolve o primeiro que existe de fato. Nenhuma destas
// linhas pode lançar no import, senão a função morre antes de qualquer tratamento de erro.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function projectDir(name: string, moduleUrl: string | undefined): string {
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(moduleUrl!));
    candidates.push(join(here, '..', name));  // src/db.ts -> <raiz>/migrations
    candidates.push(join(here, name));        // bundle na raiz -> <raiz>/migrations
  } catch { /* sem import.meta utilizável: sobra o cwd */ }
  candidates.push(resolve(process.cwd(), name));
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* caminho inacessível: tenta o próximo */ }
  }
  // Nenhum existe: devolve o último para a mensagem de erro citar um caminho previsível.
  return candidates[candidates.length - 1];
}
