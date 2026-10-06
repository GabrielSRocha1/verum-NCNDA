// Motor de grade e comissões. Percentuais em pontos-base inteiros (1 bps = 0,01%).
// Valores monetários em BigInt na unidade mínima do ativo. Nenhum float em nenhum ponto.

export type LineKind = 'PAGADOR' | 'GRUPO_VENDA' | 'GRUPO_COMPRA' | 'INTERMEDIACAO' | 'COMISSAO' | 'RESIDUO';
export type ResidualPolicy = 'TO_PAY_MASTER' | 'TO_PAYER' | 'TO_SELL_INTERMEDIARY' | 'TO_BUY_INTERMEDIARY';
export const RESIDUAL_POLICIES: ResidualPolicy[] = ['TO_PAY_MASTER', 'TO_PAYER', 'TO_SELL_INTERMEDIARY', 'TO_BUY_INTERMEDIARY'];
export const LINE_KINDS: LineKind[] = ['PAGADOR', 'GRUPO_VENDA', 'GRUPO_COMPRA', 'INTERMEDIACAO', 'COMISSAO', 'RESIDUO'];

export interface AllocationLine {
  lineKey: string;
  label: string;
  roleKey: string | null;
  roleSeq: number;
  bps: number;
  kind: LineKind;
}

export interface Grade { totalBps: number; payerBps: number }

function assertBps(n: number, what = 'bps'): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) throw new Error(`${what} inválido: ${n}`);
}

/** Converte "3,33" / "3.33" / "25" em bps inteiros, por aritmética de string (sem float). */
export function percentToBps(input: string): number {
  const s = String(input).trim().replace('%', '').replace(',', '.');
  const m = s.match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Percentual inválido: "${input}" (use até 2 casas decimais)`);
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  assertBps(bps, 'percentual');
  return bps;
}

/** "25/15" → { totalBps: 2500, payerBps: 1500 }. Aceita decimais: "7,5/4". */
export function parseGrade(input: string): Grade {
  const m = String(input).trim().match(/^([\d.,]+)\s*\/\s*([\d.,]+)$/);
  if (!m) throw new Error(`Grade inválida: "${input}" (formato X/Y)`);
  const totalBps = percentToBps(m[1]);
  const payerBps = percentToBps(m[2]);
  if (totalBps === 0) throw new Error('Deságio total da grade não pode ser zero');
  if (payerBps > totalBps) throw new Error('Parte do Pagador (Y) não pode exceder o deságio total (X)');
  return { totalBps, payerBps };
}

/** bps → "3,33%" (string exata, sem float). */
export function formatBps(bps: number): string {
  assertBps(bps);
  const int = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0');
  return `${int},${frac}%`;
}

export function formatGrade(totalBps: number, payerBps: number): string {
  const f = (b: number) => (b % 100 === 0 ? String(b / 100) : formatBps(b).replace('%', ''));
  return `${f(totalBps)}/${f(payerBps)}`;
}

/** Divide `total` bps em `parts` partes iguais; o resto vira resíduo explícito. */
export function splitBps(total: number, parts: number): { shares: number[]; residual: number } {
  assertBps(total);
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 20) throw new Error(`Número de partes inválido: ${parts}`);
  const each = Math.floor(total / parts);
  return { shares: Array.from({ length: parts }, () => each), residual: total - each * parts };
}

export interface ResidualTarget { roleKey: string; roleSeq: number }

/** Resolve para quem vai o resíduo conforme a política travada. */
export function residualTarget(policy: ResidualPolicy, lines: AllocationLine[]): ResidualTarget {
  switch (policy) {
    case 'TO_PAY_MASTER': return { roleKey: 'PAY_MASTER', roleSeq: 1 };
    case 'TO_SELL_INTERMEDIARY': return { roleKey: 'INTERMEDIACAO_VENDA', roleSeq: 1 };
    case 'TO_BUY_INTERMEDIARY': return { roleKey: 'INTERMEDIACAO_COMPRA', roleSeq: 1 };
    case 'TO_PAYER': {
      const payer = lines.find((l) => l.kind === 'PAGADOR' && l.roleKey);
      if (!payer || !payer.roleKey) throw new Error('Política TO_PAYER exige uma linha PAGADOR vinculada a uma função');
      return { roleKey: payer.roleKey, roleSeq: payer.roleSeq };
    }
    default: throw new Error(`Política de resíduo inválida: ${policy}`);
  }
}

/**
 * Divide uma fatia de intermediação em N partes e devolve as linhas, com o resíduo em linha própria.
 * Ex.: 334 bps em 3 → 111 + 111 + 111 + RESIDUO 1.
 */
export function buildSplitLines(
  baseKey: string, labelPrefix: string, totalBps: number,
  roles: { roleKey: string; roleSeq?: number; label: string }[],
  kind: LineKind, policy: ResidualPolicy, allLinesForPayer: AllocationLine[] = [],
): AllocationLine[] {
  const { shares, residual } = splitBps(totalBps, roles.length);
  const out: AllocationLine[] = roles.map((r, i) => ({
    lineKey: `${baseKey}_${i + 1}`,
    label: `${labelPrefix} — ${r.label}`,
    roleKey: r.roleKey,
    roleSeq: r.roleSeq ?? 1,
    bps: shares[i],
    kind,
  }));
  if (residual > 0) {
    const t = residualTarget(policy, allLinesForPayer);
    out.push({ lineKey: `${baseKey}_residuo`, label: 'Resíduo de divisão', roleKey: t.roleKey, roleSeq: t.roleSeq, bps: residual, kind: 'RESIDUO' });
  }
  return out;
}

export interface LinesValidation { ok: boolean; sum: number; expected: number; errors: string[] }

export function validateLines(lines: AllocationLine[], gradeTotalBps: number): LinesValidation {
  const errors: string[] = [];
  assertBps(gradeTotalBps, 'grade');
  const keys = new Set<string>();
  let sum = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.bps) || l.bps < 0 || l.bps > 10_000) errors.push(`Linha ${l.lineKey}: bps deve ser inteiro entre 0 e 10000`);
    if (!/^[a-z0-9_]{1,40}$/.test(l.lineKey)) errors.push(`Chave de linha inválida: ${l.lineKey}`);
    if (keys.has(l.lineKey)) errors.push(`Chave de linha duplicada: ${l.lineKey}`);
    keys.add(l.lineKey);
    if (!LINE_KINDS.includes(l.kind)) errors.push(`Tipo de linha inválido: ${l.kind}`);
    if (typeof l.bps === 'number' && Number.isSafeInteger(l.bps)) sum += l.bps;
  }
  if (sum !== gradeTotalBps) errors.push(`Soma das linhas (${formatBps(Math.min(sum, 10000))}) diferente do deságio total da grade (${formatBps(gradeTotalBps)})`);
  return { ok: errors.length === 0, sum, expected: gradeTotalBps, errors };
}

export interface DistributedLine extends AllocationLine { amount: bigint }
export interface Distribution {
  referenceAmount: bigint;
  poolAmount: bigint;            // floor(ref * total_bps / 10000)
  lines: DistributedLine[];      // inclui a linha "Resíduo de divisão" de unidades, quando houver
  residualUnits: bigint;         // unidades mínimas que sobraram da divisão por linha
  truncatedNumerator: number;    // fração abaixo da unidade mínima: truncatedNumerator / 10000 unidade (não distribuível)
}

/** Distribuição exata por bps. Soma das linhas == pool, sempre. Determinística. */
export function distribute(referenceAmount: bigint, lines: AllocationLine[], gradeTotalBps: number, policy: ResidualPolicy): Distribution {
  if (typeof referenceAmount !== 'bigint' || referenceAmount <= 0n) throw new Error('Valor de referência deve ser BigInt positivo');
  const v = validateLines(lines, gradeTotalBps);
  if (!v.ok) throw new Error(`Linhas inválidas: ${v.errors.join('; ')}`);
  const gross = referenceAmount * BigInt(gradeTotalBps);
  const poolAmount = gross / 10_000n;
  const truncatedNumerator = Number(gross % 10_000n);
  const out: DistributedLine[] = lines.map((l) => ({ ...l, amount: (referenceAmount * BigInt(l.bps)) / 10_000n }));
  const assigned = out.reduce((a, l) => a + l.amount, 0n);
  const residualUnits = poolAmount - assigned;
  if (residualUnits < 0n) throw new Error('Invariante violada: resíduo negativo');
  if (residualUnits > 0n) {
    const t = residualTarget(policy, lines);
    out.push({ lineKey: 'residuo_unidades', label: 'Resíduo de divisão (unidades mínimas)', roleKey: t.roleKey, roleSeq: t.roleSeq, bps: 0, kind: 'RESIDUO', amount: residualUnits });
  }
  const total = out.reduce((a, l) => a + l.amount, 0n);
  if (total !== poolAmount) throw new Error('Invariante violada: soma distribuída diferente do pool');
  return { referenceAmount, poolAmount, lines: out, residualUnits, truncatedNumerator };
}

/** Converte "1.234,56" ou "1234.56" para unidade mínima. Rejeita casas além de `decimals`. */
export function parseUnits(input: string, decimals: number): bigint {
  const s = String(input).trim().replace(/\s/g, '');
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const m = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`Valor inválido: "${input}"`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`Valor com mais de ${decimals} casas decimais`);
  return BigInt(m[1] + frac.padEnd(decimals, '0'));
}

/** Unidade mínima → "1.234.567,89" (pt-BR), sem perder precisão. */
export function formatUnits(amount: bigint, decimals: number, opts: { trim?: boolean } = {}): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const s = a.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals) || '0';
  let frac = decimals > 0 ? s.slice(s.length - decimals) : '';
  if (opts.trim) frac = frac.replace(/0+$/, '');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${intFmt}${frac ? ',' + frac : ''}`;
}

/** Unidade mínima → uiAmountString ("1234.5"), formato exigido pelo Solana Pay. */
export function toUiAmountString(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new Error('Valor negativo');
  const s = amount.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return frac ? `${int}.${frac}` : int;
}

/** Soma de bps por participante (função + sequência). */
export function bpsByRole(lines: AllocationLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!l.roleKey) continue;
    const k = `${l.roleKey}#${l.roleSeq}`;
    m.set(k, (m.get(k) ?? 0) + l.bps);
  }
  return m;
}
