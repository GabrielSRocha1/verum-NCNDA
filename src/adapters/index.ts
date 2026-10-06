// Adapters (injeção de dependência / Open-Closed). Cada rede nova entra como implementação nova,
// sem alterar o domínio. Integrações que ainda não existem de verdade ficam como DEMO, marcadas.
import { createHash } from 'node:crypto';
import { verifyEd25519, isSolanaAddress, base58Encode } from '../lib/crypto.ts';
import { toUiAmountString, distribute, type AllocationLine, type ResidualPolicy, type Distribution } from '../lib/bps.ts';

// ================================================================= SignatureAdapter
export interface SignatureAdapter {
  readonly network: string;
  isValidAddress(address: string): boolean;
  /** Verifica assinatura de MENSAGEM (identidade/aceite). Nunca transação. */
  verifyMessage(address: string, message: string, signature: string): boolean;
}
export class SolanaSignatureAdapter implements SignatureAdapter {
  readonly network: string;
  constructor(network: string) { this.network = network; }
  isValidAddress(a: string) { return isSolanaAddress(a); }
  verifyMessage(a: string, m: string, s: string) { return verifyEd25519(a, m, s); }
}

// ================================================================= Asset Registry / AssetAdapter
export type LegType = 'ONCHAIN' | 'CASH_PHYSICAL' | 'FIAT_TRANSFER' | 'PHYSICAL_ASSET';
export interface AssetRecord {
  id: string; symbol: string; name: string; network: string; mint: string | null; decimals: number;
  status: 'ACTIVE' | 'DISABLED'; verified: boolean; legType: LegType; environment: 'DEMO' | 'DEVNET' | 'MAINNET' | 'OFFCHAIN';
}

/** Mint determinístico para a rede DEMO (endereço válido, sem existência on-chain). */
export function demoMint(symbol: string): string {
  return base58Encode(createHash('sha256').update(`verum-ncnda-demo-mint:${symbol}`).digest());
}

export function defaultAssetRegistry(): AssetRecord[] {
  return [
    { id: 'USDT:solana-demo', symbol: 'USDT', name: 'Tether USD (DEMO)', network: 'solana-demo', mint: demoMint('USDT'), decimals: 6, status: 'ACTIVE', verified: true, legType: 'ONCHAIN', environment: 'DEMO' },
    { id: 'USDC:solana-demo', symbol: 'USDC', name: 'USD Coin (DEMO)', network: 'solana-demo', mint: demoMint('USDC'), decimals: 6, status: 'ACTIVE', verified: true, legType: 'ONCHAIN', environment: 'DEMO' },
    { id: 'SOL:solana-demo', symbol: 'SOL', name: 'Solana (DEMO)', network: 'solana-demo', mint: null, decimals: 9, status: 'ACTIVE', verified: true, legType: 'ONCHAIN', environment: 'DEMO' },
    { id: 'BTC:bitcoin-demo', symbol: 'BTC', name: 'Bitcoin (DEMO)', network: 'bitcoin-demo', mint: null, decimals: 8, status: 'ACTIVE', verified: true, legType: 'ONCHAIN', environment: 'DEMO' },
    // Devnet: mint oficial da Circle para USDC na Solana Devnet.
    { id: 'USDC:solana-devnet', symbol: 'USDC', name: 'USD Coin (Devnet)', network: 'solana-devnet', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6, status: 'ACTIVE', verified: true, legType: 'ONCHAIN', environment: 'DEVNET' },
    { id: 'SOL:solana-devnet', symbol: 'SOL', name: 'Solana (Devnet)', network: 'solana-devnet', mint: null, decimals: 9, status: 'ACTIVE', verified: true, legType: 'ONCHAIN', environment: 'DEVNET' },
    // Mainnet: registrados e verificados, porém DESLIGADOS até autorização explícita.
    { id: 'USDT:solana-mainnet', symbol: 'USDT', name: 'Tether USD', network: 'solana-mainnet', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCemBhKkuEZ', decimals: 6, status: 'DISABLED', verified: true, legType: 'ONCHAIN', environment: 'MAINNET' },
    { id: 'USDC:solana-mainnet', symbol: 'USDC', name: 'USD Coin', network: 'solana-mainnet', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, status: 'DISABLED', verified: true, legType: 'ONCHAIN', environment: 'MAINNET' },
    // Pernas fora da plataforma (informativas, nunca garantidas por contrato).
    { id: 'USD:cash', symbol: 'USD', name: 'Dólar em espécie', network: 'offchain', mint: null, decimals: 2, status: 'ACTIVE', verified: false, legType: 'CASH_PHYSICAL', environment: 'OFFCHAIN' },
    { id: 'BRL:fiat', symbol: 'BRL', name: 'Real (transferência bancária/PIX)', network: 'offchain', mint: null, decimals: 2, status: 'ACTIVE', verified: false, legType: 'FIAT_TRANSFER', environment: 'OFFCHAIN' },
    { id: 'PHYSICAL:asset', symbol: 'ATIVO FÍSICO', name: 'Ativo físico (descrição livre)', network: 'offchain', mint: null, decimals: 0, status: 'ACTIVE', verified: false, legType: 'PHYSICAL_ASSET', environment: 'OFFCHAIN' },
  ];
}

export interface AssetCheck { ok: boolean; reason?: string; asset?: AssetRecord }
export class AssetAdapter {
  private registry: AssetRecord[];
  private mainnetEnabled: boolean;
  constructor(registry: AssetRecord[], mainnetEnabled: boolean) { this.registry = registry; this.mainnetEnabled = mainnetEnabled; }
  list() { return this.registry; }
  byId(id: string) { return this.registry.find((a) => a.id === id) ?? null; }
  /** Nunca confia em símbolo: rede + mint/contrato + decimals precisam bater com um registro verificado e ativo. */
  validateOnchain(input: { symbol: string; network: string; mint: string | null; decimals: number }): AssetCheck {
    const candidates = this.registry.filter((a) => a.network === input.network && a.legType === 'ONCHAIN');
    const match = candidates.find((a) => (a.mint ?? null) === (input.mint ?? null));
    if (!match) {
      const lookalike = candidates.find((a) => a.symbol.toUpperCase() === String(input.symbol).toUpperCase());
      return { ok: false, reason: lookalike ? 'LOOKALIKE_TOKEN: símbolo conhecido com mint diferente do registro verificado' : 'ASSET_NOT_REGISTERED' };
    }
    if (match.decimals !== input.decimals) return { ok: false, reason: 'DECIMALS_MISMATCH' };
    if (match.symbol.toUpperCase() !== String(input.symbol).toUpperCase()) return { ok: false, reason: 'SYMBOL_MISMATCH' };
    if (!match.verified) return { ok: false, reason: 'ASSET_NOT_VERIFIED' };
    if (match.environment === 'MAINNET' && !this.mainnetEnabled) return { ok: false, reason: 'MAINNET_DISABLED' };
    if (match.status !== 'ACTIVE') return { ok: false, reason: 'ASSET_DISABLED' };
    return { ok: true, asset: match };
  }
}

// ================================================================= QrPayloadAdapter
export interface QrPayloadInput {
  recipient: string;
  asset: AssetRecord | null;
  amount?: bigint | null;     // unidade mínima
  label?: string;
  message?: string;
}
export interface QrPayload { uri: string; format: 'SOLANA_PAY' | 'ADDRESS'; demo: boolean }
export interface QrPayloadAdapter { readonly networks: string[]; build(input: QrPayloadInput): QrPayload }

/** Solana Pay — Transfer Request: solana:<recipient>?amount=&spl-token=&label=&message= (amount em uiAmountString). */
export class SolanaPayQrAdapter implements QrPayloadAdapter {
  readonly networks = ['solana-devnet', 'solana-mainnet'];
  build(i: QrPayloadInput): QrPayload {
    if (!isSolanaAddress(i.recipient)) throw new Error('Endereço Solana inválido');
    const params: string[] = [];
    if (i.amount !== undefined && i.amount !== null && i.asset) params.push(`amount=${toUiAmountString(i.amount, i.asset.decimals)}`);
    if (i.asset?.mint) params.push(`spl-token=${i.asset.mint}`);
    if (i.label) params.push(`label=${encodeURIComponent(i.label)}`);
    if (i.message) params.push(`message=${encodeURIComponent(i.message)}`);
    return { uri: `solana:${i.recipient}${params.length ? '?' + params.join('&') : ''}`, format: 'SOLANA_PAY', demo: false };
  }
}
/** Rede DEMO: mints fictícios não podem ir para um QR que uma carteira real tentaria pagar. Só endereço + rótulo. */
export class DemoQrAdapter implements QrPayloadAdapter {
  readonly networks = ['solana-demo'];
  build(i: QrPayloadInput): QrPayload {
    if (!isSolanaAddress(i.recipient)) throw new Error('Endereço inválido');
    const params = [`label=${encodeURIComponent('DEMO — NO REAL FUNDS')}`];
    if (i.message) params.push(`message=${encodeURIComponent(i.message)}`);
    return { uri: `solana:${i.recipient}?${params.join('&')}`, format: 'SOLANA_PAY', demo: true };
  }
}
/** Outras redes: endereço puro até existir adapter específico. */
export class AddressOnlyQrAdapter implements QrPayloadAdapter {
  readonly networks = ['*'];
  build(i: QrPayloadInput): QrPayload { return { uri: i.recipient, format: 'ADDRESS', demo: false }; }
}
export function qrAdapterFor(network: string): QrPayloadAdapter {
  for (const a of [new DemoQrAdapter(), new SolanaPayQrAdapter()]) if (a.networks.includes(network)) return a;
  return new AddressOnlyQrAdapter();
}

// ================================================================= SettlementAdapter
export interface SettlementPlan {
  versionId: string;
  referenceAmount: bigint;
  lines: AllocationLine[];
  gradeTotalBps: number;
  residualPolicy: ResidualPolicy;
}
export interface SettlementAdapter {
  readonly id: string;
  readonly protectedByContract: boolean;   // false = nunca exibir selo de proteção
  readonly demo: boolean;
  plan(p: SettlementPlan): Distribution;
  /** Executa a distribuição. DEMO: simulação local, nenhum fundo se move. */
  execute(p: SettlementPlan): { distribution: Distribution; reference: string };
}
export class DemoSettlementAdapter implements SettlementAdapter {
  readonly id = 'DEMO_SIMULATED';
  readonly protectedByContract = false;
  readonly demo = true;
  plan(p: SettlementPlan) { return distribute(p.referenceAmount, p.lines, p.gradeTotalBps, p.residualPolicy); }
  execute(p: SettlementPlan) {
    const distribution = this.plan(p);
    return { distribution, reference: `DEMO-SIM-${p.versionId.slice(0, 8)}` };
  }
}

// ================================================================= BlockchainAdapter
export interface BlockchainAdapter {
  readonly network: string;
  readonly available: boolean;
  readonly reason?: string;
  explorerUrl?(address: string): string;
}
export class DemoBlockchainAdapter implements BlockchainAdapter {
  readonly network = 'solana-demo';
  readonly available = true;
}
/** Devnet: integração real ainda não implementada — declarada indisponível, sem fingir funcionamento. */
export class PendingDevnetAdapter implements BlockchainAdapter {
  readonly network = 'solana-devnet';
  readonly available = false;
  readonly reason = 'Integração Solana Devnet ainda não implementada (fase 13/14). Use SOLANA_NETWORK=solana-demo.';
}

// ================================================================= WalletAdapter (servidor)
// A exigência "somente Verum Wallet" é aplicada no CLIENTE (public/js/wallet-adapter.js).
// O servidor não consegue saber qual software gerou a assinatura — não existe atestação pública
// da Verum Wallet até aqui, então nada é afirmado como "verificado" quanto à origem do software.
export const WALLET_ATTESTATION_AVAILABLE = false;
