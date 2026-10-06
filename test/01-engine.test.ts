import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { parseGrade, splitBps, validateLines, distribute, formatBps, parseUnits, formatUnits, toUiAmountString, percentToBps, type AllocationLine } from '../src/lib/bps.ts';
import { templateLines } from '../src/services/partnership.ts';
import { base58Encode, base58Decode, verifyEd25519, canonicalJson, newInviteCode, normalizeInviteCode, CODE_ALPHABET, safeEqualHex } from '../src/lib/crypto.ts';
import { AssetAdapter, defaultAssetRegistry, SolanaPayQrAdapter, DemoQrAdapter, qrAdapterFor, demoMint } from '../src/adapters/index.ts';
import { selectProvider, createWalletAdapter, DemoVerumWalletProvider } from '../public/js/wallet-adapter.js';
import { choiceState, pctToBps } from '../public/js/onboarding-logic.js';
import { maskEmail, maskPhone } from '../src/lib/common.ts';

const ALL = new Set(['VENDEDOR', 'GRUPO_VENDA', 'INTERMEDIACAO_VENDA', 'PAY_MASTER', 'INTERMEDIACAO_COMPRA', 'GRUPO_COMPRA', 'COMPRADOR']);
const sum = (ls: AllocationLine[]) => ls.reduce((a, l) => a + l.bps, 0);

test('6(a) grade 25/15 → 1500 + 333 + 333 + 111+111+111 + resíduo 1 para o Pay Master; soma 2500', () => {
  const g = parseGrade('25/15');
  assert.equal(g.totalBps, 2500); assert.equal(g.payerBps, 1500);
  const lines = templateLines(2500, 1500, ALL, 'TO_PAY_MASTER');
  const by = Object.fromEntries(lines.map((l) => [l.lineKey, l.bps]));
  assert.equal(by.pagador, 1500); assert.equal(by.grupo_venda, 333); assert.equal(by.grupo_compra, 333);
  assert.deepEqual([by.intermediacao_1, by.intermediacao_2, by.intermediacao_3], [111, 111, 111]);
  const res = lines.find((l) => l.kind === 'RESIDUO')!;
  assert.equal(res.bps, 1); assert.equal(res.roleKey, 'PAY_MASTER'); assert.equal(formatBps(res.bps), '0,01%');
  assert.equal(sum(lines), 2500);
  assert.ok(validateLines(lines, 2500).ok);
});

test('6(b) grade 7/4 → 400 + 100 + 100 + 50 + 50 = 700', () => {
  const lines: AllocationLine[] = [
    { lineKey: 'pagador', label: 'Pagador', roleKey: 'COMPRADOR', roleSeq: 1, bps: 400, kind: 'PAGADOR' },
    { lineKey: 'compra', label: 'Compra', roleKey: 'GRUPO_COMPRA', roleSeq: 1, bps: 100, kind: 'GRUPO_COMPRA' },
    { lineKey: 'venda', label: 'Venda', roleKey: 'GRUPO_VENDA', roleSeq: 1, bps: 100, kind: 'GRUPO_VENDA' },
    { lineKey: 'iv', label: 'Int. venda', roleKey: 'INTERMEDIACAO_VENDA', roleSeq: 1, bps: 50, kind: 'INTERMEDIACAO' },
    { lineKey: 'ic', label: 'Int. compra', roleKey: 'INTERMEDIACAO_COMPRA', roleSeq: 1, bps: 50, kind: 'INTERMEDIACAO' },
  ];
  assert.equal(sum(lines), 700); assert.ok(validateLines(lines, parseGrade('7/4').totalBps).ok);
});

test('6(c) grade 12/8 → 800 + 200 + 200 = 1200', () => {
  const lines: AllocationLine[] = [
    { lineKey: 'pagador', label: 'Pagador', roleKey: 'COMPRADOR', roleSeq: 1, bps: 800, kind: 'PAGADOR' },
    { lineKey: 'venda', label: 'Venda fechada', roleKey: 'GRUPO_VENDA', roleSeq: 1, bps: 200, kind: 'GRUPO_VENDA' },
    { lineKey: 'ci', label: 'Compra e intermediários', roleKey: 'GRUPO_COMPRA', roleSeq: 1, bps: 200, kind: 'GRUPO_COMPRA' },
  ];
  assert.equal(sum(lines), 1200); assert.ok(validateLines(lines, 1200).ok);
});

test('6 soma que não fecha bloqueia; resíduo determinístico; sem float; mesma entrada → mesma saída', () => {
  const bad = validateLines([{ lineKey: 'a', label: 'A', roleKey: null, roleSeq: 1, bps: 2499, kind: 'COMISSAO' }], 2500);
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /Soma/);
  assert.deepEqual(splitBps(334, 3), { shares: [111, 111, 111], residual: 1 });
  assert.deepEqual(splitBps(1000, 3), { shares: [333, 333, 333], residual: 1 });
  assert.equal(validateLines([{ lineKey: 'a', label: 'A', roleKey: null, roleSeq: 1, bps: 33.3 as any, kind: 'COMISSAO' }], 2500).ok, false); // bps decimal é recusado
  assert.equal(percentToBps('3,33'), 333); assert.throws(() => percentToBps('3,333'));
  const a = templateLines(2500, 1500, ALL, 'TO_PAY_MASTER'); const b = templateLines(2500, 1500, ALL, 'TO_PAY_MASTER');
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('6 distribuição exata por bps em BigInt: soma das linhas == pool, resíduo de unidades explícito, fração truncada visível', () => {
  const lines = templateLines(2500, 1500, ALL, 'TO_PAY_MASTER');
  const ref = parseUnits('1000000.037777', 6);
  const d = distribute(ref, lines, 2500, 'TO_PAY_MASTER');
  assert.equal(d.poolAmount, ref * 2500n / 10000n);
  assert.equal(d.lines.reduce((a, l) => a + l.amount, 0n), d.poolAmount);
  const resid = d.lines.find((l) => l.lineKey === 'residuo_unidades');
  if (d.residualUnits > 0n) { assert.ok(resid); assert.equal(resid!.roleKey, 'PAY_MASTER'); }
  assert.equal(d.truncatedNumerator, Number((ref * 2500n) % 10000n));
  assert.equal(formatUnits(ref, 6), '1.000.000,037777');
  assert.equal(toUiAmountString(1500000n, 6), '1.5');
  assert.throws(() => distribute(ref, [{ ...lines[0], bps: 1 }], 2500, 'TO_PAY_MASTER'));
});

test('crypto: base58 ida e volta, Ed25519 válida/inválida, código VOTC sem caracteres ambíguos, comparação segura', () => {
  const kp = nacl.sign.keyPair();
  const addr = base58Encode(kp.publicKey);
  assert.deepEqual(base58Decode(addr), kp.publicKey);
  const msg = 'VERUM NCNDA teste';
  const sig = base58Encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));
  assert.ok(verifyEd25519(addr, msg, sig));
  assert.equal(verifyEd25519(addr, msg + '!', sig), false);
  assert.equal(verifyEd25519(base58Encode(nacl.sign.keyPair().publicKey), msg, sig), false);
  for (let i = 0; i < 50; i++) { const c = newInviteCode(); assert.match(c, /^VOTC-[A-Z2-9]{6}$/); for (const ch of c.slice(5)) assert.ok(CODE_ALPHABET.includes(ch)); }
  assert.equal(normalizeInviteCode(' votc-ab cd23 '), 'VOTC-ABCD23'); assert.equal(normalizeInviteCode('VOTC-ABCD10'), null);
  assert.ok(safeEqualHex('ab', 'ab')); assert.equal(safeEqualHex('ab', 'ac'), false); assert.equal(safeEqualHex('ab', 'abcd'), false);
  assert.equal(maskEmail('joao@dominio.com'), 'j***@dominio.com'); assert.equal(maskPhone('+55 11 91234-5678'), '+55 ** *****-5678');
});

test('14 Asset Registry: nunca confia em símbolo — mint lookalike, decimals e mainnet são recusados', () => {
  const a = new AssetAdapter(defaultAssetRegistry(), false);
  assert.ok(a.validateOnchain({ symbol: 'USDT', network: 'solana-demo', mint: demoMint('USDT'), decimals: 6 }).ok);
  assert.equal(a.validateOnchain({ symbol: 'USDT', network: 'solana-demo', mint: demoMint('FAKE'), decimals: 6 }).reason, 'LOOKALIKE_TOKEN: símbolo conhecido com mint diferente do registro verificado');
  assert.equal(a.validateOnchain({ symbol: 'USDT', network: 'solana-demo', mint: demoMint('USDT'), decimals: 9 }).reason, 'DECIMALS_MISMATCH');
  assert.equal(a.validateOnchain({ symbol: 'USDT', network: 'solana-mainnet', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCemBhKkuEZ', decimals: 6 }).reason, 'MAINNET_DISABLED');
  assert.equal(a.validateOnchain({ symbol: 'USDC', network: 'solana-devnet', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 }).ok, true);
});

test('11 QrPayloadAdapter: Solana Pay com amount em uiAmountString e spl-token; DEMO sem mint fictício; outras redes = endereço puro', () => {
  const addr = base58Encode(nacl.sign.keyPair().publicKey);
  const usdc = defaultAssetRegistry().find((x) => x.id === 'USDC:solana-devnet')!;
  const uri = new SolanaPayQrAdapter().build({ recipient: addr, asset: usdc, amount: 12500000n, label: 'VERUM NCNDA', message: 'OTC-0001 Vendedor' }).uri;
  assert.equal(uri, `solana:${addr}?amount=12.5&spl-token=${usdc.mint}&label=VERUM%20OTC&message=OTC-0001%20Vendedor`);
  const demo = new DemoQrAdapter().build({ recipient: addr, asset: defaultAssetRegistry()[0], amount: 1n });
  assert.ok(demo.demo); assert.ok(!demo.uri.includes('spl-token')); assert.ok(demo.uri.startsWith(`solana:${addr}?label=DEMO`));
  assert.equal(qrAdapterFor('bitcoin-demo').build({ recipient: addr, asset: null }).format, 'ADDRESS');
});

test('12 WalletAdapter (cliente): recusa providers que não sejam a Verum Wallet; TELA 1 muda com isAvailable()', () => {
  assert.throws(() => selectProvider([{ id: 'phantom', isVerumWallet: false }, { id: 'verum-wallet', isVerumWallet: false }]), /Somente a Verum Wallet/);
  assert.throws(() => selectProvider([{ id: 'solflare' }]));
  globalThis.nacl = nacl;
  const ad = createWalletAdapter({ demoMode: true, injected: [{ id: 'phantom', isVerumWallet: true }] });
  assert.ok(ad.provider instanceof DemoVerumWalletProvider); assert.ok(ad.isAvailable()); assert.equal(ad.attestation, null);
  assert.equal(createWalletAdapter({ demoMode: false }).isAvailable(), false);
  assert.equal(createWalletAdapter({ demoMode: true, simulateMissing: true }).isAvailable(), false);
  const miss = choiceState({ walletAvailable: false, downloadUrl: '' });
  assert.equal(miss.primary, 'download'); assert.equal(miss.signupDisabled, true); assert.equal(miss.showDownload, false); assert.match(miss.downloadFallback, /Peça o link/);
  const ok = choiceState({ walletAvailable: true, downloadUrl: 'https://x' });
  assert.equal(ok.primary, 'signup'); assert.equal(ok.signupDisabled, false); assert.equal(ok.showDownload, true);
  assert.equal(pctToBps('3,33'), 333); assert.equal(pctToBps('abc'), null);
});

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

test('17 contraste ≥ 4,5:1 nos pares de cores do design system; PAY MASTER com white-space:nowrap', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  const v = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))![1];
  assert.ok(contrast(v('verum-blue'), v('white')) >= 4.5, `azul Verum × branco = ${contrast(v('verum-blue'), v('white')).toFixed(2)}`);
  assert.ok(contrast(v('verum-blue-deep'), v('white')) >= 4.5);
  assert.ok(contrast(v('text'), v('obsidian')) >= 4.5);
  assert.ok(contrast(v('muted'), v('surface')) >= 4.5);
  assert.ok(contrast(v('green'), v('green-ink')) >= 4.5);
  assert.ok(contrast(v('red'), v('obsidian')) >= 4.5);
  assert.match(css, /\.pm-badge\s*\{[^}]*white-space:\s*nowrap/);
  assert.doesNotMatch(css, /\.btn-primary\s*\{[^}]*D9A94B/i); // dourado nunca em botão primário
});
