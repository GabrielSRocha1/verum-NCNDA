// Envio de e-mail (SMTP). Serve a uma promessa feita na tela: "o retorno vai para o e-mail que
// você cadastrou". Sem credencial configurada o envio fica DESLIGADO e isso é dito em voz alta —
// a interface deixa de prometer e o comando avisa o operador, em vez de fingir que mandou.
//
// Regra que vale para todos os caminhos: e-mail NUNCA derruba a operação. A conta é criada, a
// solicitação é registrada, e a falha de envio vira aviso — não transação desfeita.
import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.ts';

export interface Mensagem {
  para: string;
  assunto: string;
  texto: string;
}

export interface Envio { ok: boolean; motivo?: string; id?: string }

export interface Mailer {
  readonly enabled: boolean;
  readonly remetente: string;
  readonly operador: string | null;
  send(m: Mensagem): Promise<Envio>;
  /** Conversa com o servidor sem enviar nada: confirma host, porta, SSL e senha. */
  verify(): Promise<Envio>;
}

const DESLIGADO = 'Envio de e-mail desligado (SMTP_PASS não configurada).';

export function createMailer(cfg: AppConfig, logger?: { error: (...a: any[]) => void }): Mailer {
  const log = logger ?? console;
  if (!cfg.smtp) {
    return {
      enabled: false, remetente: '', operador: null,
      async send(m) { log.error(`[e-mail desligado] para ${m.para}: ${m.assunto}`); return { ok: false, motivo: DESLIGADO }; },
      async verify() { return { ok: false, motivo: DESLIGADO }; },
    };
  }
  const { host, port, user, pass, from, operador } = cfg.smtp;
  // Tempos curtos de propósito: num deploy serverless, SMTP pendurado seguraria a requisição da
  // pessoa. Melhor falhar o envio e registrar do que fazer o cadastro parecer travado.
  const transporte = nodemailer.createTransport({
    host, port,
    secure: port === 465,              // 465 = TLS implícito (SSL); 587 = STARTTLS
    auth: { user, pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  });
  return {
    enabled: true, remetente: from, operador,
    async send(m) {
      try {
        const info = await transporte.sendMail({ from, to: m.para, subject: m.assunto, text: m.texto });
        return { ok: true, id: info.messageId };
      } catch (e) {
        const motivo = (e as Error)?.message ?? String(e);
        log.error(`Falha ao enviar e-mail para ${m.para}: ${motivo}`);
        return { ok: false, motivo };
      }
    },
    async verify() {
      try { await transporte.verify(); return { ok: true }; }
      catch (e) { return { ok: false, motivo: (e as Error)?.message ?? String(e) }; }
    },
  };
}

/**
 * Envia com teto de tempo, sem nunca lançar.
 *
 * Por que não "dispara e esquece": num deploy serverless a função é CONGELADA assim que responde,
 * e trabalho assíncrono pendente morre junto — "dispara e esquece" vira "esquece". Então o envio é
 * aguardado, mas com teto curto: se o SMTP demorar, a resposta sai mesmo assim e o registro já
 * está gravado. E-mail continua sem poder derrubar a operação.
 */
export async function enviarComLimite(mailer: Mailer, m: Mensagem, ms = 6000): Promise<Envio> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mailer.send(m),
      new Promise<Envio>((r) => { timer = setTimeout(() => r({ ok: false, motivo: `sem resposta do servidor de e-mail em ${ms}ms` }), ms); }),
    ]);
  } catch (e) {
    return { ok: false, motivo: (e as Error)?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}
