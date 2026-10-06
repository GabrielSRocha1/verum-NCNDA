// Entrada serverless (Vercel). O app Fastify é construído UMA vez por instância e reaproveitado
// entre invocações; cada requisição é entregue ao roteador dele. O servidor de processo longo
// (src/server.ts) continua sendo o caminho de referência — este arquivo só adapta a entrada.
//
// Duas diferenças que valem saber, porque mudam comportamento e não só desempenho:
//  1. O rate limit por IP (src/lib/common.ts) vive na memória da instância, então aqui ele conta
//     por instância, não global. A defesa dura contra chute de código do convite não é essa: é o
//     contador no banco, que BLOQUEIA o convite em 5 erros (src/services/invitations.ts).
//  2. O varredor periódico de convites expirados (setInterval em src/app.ts) não roda sozinho num
//     processo que só vive durante a requisição. A expiração continua acontecendo porque toda
//     rota de convite varre antes de responder — só não acontece com ninguém olhando.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp, type BuiltApp } from '../src/app.ts';

let booting: Promise<BuiltApp> | null = null;

function boot(): Promise<BuiltApp> {
  booting ??= buildApp({ logger: false }).then(async (built) => {
    await built.app.ready();
    return built;
  });
  return booting;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let built: BuiltApp;
  try {
    built = await boot();
  } catch (e) {
    // Falha de boot (banco fora do ar, variável faltando) não pode envenenar a instância inteira:
    // sem isto, a Promise rejeitada ficaria em cache e TODA requisição seguinte falharia igual.
    booting = null;
    console.error('Falha ao iniciar o app:', (e as Error)?.message);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: 'UNAVAILABLE', message: 'Servidor indisponível neste momento. Tente novamente.' }));
    return;
  }
  built.app.server.emit('request', req, res);
}
