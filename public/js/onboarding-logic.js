// Regras de apresentação da TELA 1 do convite (testadas em node).
export function choiceState({ walletAvailable, downloadUrl }) {
  return {
    primary: walletAvailable ? 'signup' : 'download',
    signupDisabled: !walletAvailable,
    signupReason: walletAvailable ? null : 'Verum Wallet não encontrada neste aparelho.',
    showDownload: !!downloadUrl,
    downloadUrl: downloadUrl || null,
    downloadFallback: downloadUrl ? null : 'Peça o link de download ao responsável pela mesa.',
    afterInstall: 'Depois de instalar, peça um novo link ao responsável pela mesa.',
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
