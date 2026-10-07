// Regras de apresentação da TELA 1 do convite (testadas em node).
//
// `naVerumWallet` = a mesa está aberta DENTRO do app da Verum (iframe com a ponte de pé). Ali tudo
// que fala de instalar está errado: a carteira já está na mão de quem lê. E quando a ponte não
// responde nesse contexto, o problema é a ponte, não a ausência da carteira — mandar a pessoa
// baixar o que ela está usando é o tipo de instrução que faz desistir do convite.
export function choiceState({ walletAvailable, downloadUrl, naVerumWallet = false }) {
  return {
    primary: walletAvailable ? 'signup' : 'download',
    signupDisabled: !walletAvailable,
    signupReason: walletAvailable ? null
      : naVerumWallet ? 'A ponte com a Verum Wallet não respondeu. Feche e abra a mesa de novo pelo app da Verum.'
      : 'Verum Wallet não encontrada neste aparelho.',
    showDownload: !!downloadUrl && !naVerumWallet,
    downloadUrl: naVerumWallet ? null : (downloadUrl || null),
    downloadFallback: naVerumWallet ? 'Você já está no app da Verum: a carteira é a deste aparelho.'
      : downloadUrl ? null : 'Peça o link de download ao responsável pela mesa.',
    afterInstall: naVerumWallet ? 'Se a conexão não aparecer, abra a mesa de novo pelo app da Verum.'
      : 'Depois de instalar, peça um novo link ao responsável pela mesa.',
  };
}

/** Converte "3,33" em bps sem float. Retorna null se inválido. */
export function pctToBps(input) {
  const s = String(input ?? '').trim().replace('%', '').replace(',', '.');
  const m = s.match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return v <= 10000 ? v : null;
}
export function bpsToPct(bps) {
  return `${Math.floor(bps / 100)},${String(bps % 100).padStart(2, '0')}`;
}
