// ===================================================================================
// PRÉ-VISUALIZAÇÃO NAVEGÁVEL — backend simulado no navegador (DEMO — NO REAL FUNDS).
// Reproduz os contratos da API do servidor real (src/app.ts) com estado em localStorage.
// Assinaturas Ed25519 são verificadas de verdade (tweetnacl). Nada sai deste aparelho.
// ===================================================================================
(function () {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58enc = (bytes) => { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let o = ''; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const b of bytes) { if (b === 0) o = '1' + o; else break; } return o; };
  const b58dec = (s) => { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; } for (const c of s) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); };
  const enc = (s) => new TextEncoder().encode(s);
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const sha = (s) => hex(nacl.hash(enc(s))).slice(0, 64);
  const rnd = (n) => b58enc(nacl.randomBytes(n));
  const uuid = () => { const b = nacl.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = hex(b); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const nowIso = () => new Date().toISOString();
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const newCode = () => 'VOTC-' + Array.from(nacl.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const normCode = (c) => { const s = String(c || '').toUpperCase().replace(/[\s-]/g, ''); const body = s.startsWith('VOTC') ? s.slice(4) : s; if (body.length !== 6 || [...body].some((x) => !CODE_ALPHABET.includes(x))) return null; return 'VOTC-' + body; };
  const GENERIC = 'Este convite não é mais válido. Peça um novo link.';
  const ORIGIN = location.origin + location.pathname;

  // ------------------------------------------------------------------ números
  const fmtBps = (b) => `${Math.floor(b / 100)},${String(b % 100).padStart(2, '0')}%`;
  const fmtGrade = (t, p) => { const f = (b) => (b % 100 === 0 ? String(b / 100) : fmtBps(b).replace('%', '')); return `${f(t)}/${f(p)}`; };
  const fmtUnits = (amount, dec, trim) => { const a = BigInt(amount); const s = a.toString().padStart(dec + 1, '0'); const int = s.slice(0, s.length - dec) || '0'; let frac = dec ? s.slice(-dec) : ''; if (trim) frac = frac.replace(/0+$/, ''); return int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (frac ? ',' + frac : ''); };
  const parseUnits = (input, dec) => { const s = String(input).trim().replace(/\s/g, ''); const n = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s; const m = n.match(/^(\d+)(?:\.(\d+))?$/); if (!m) throw new Error('Valor inválido'); const frac = m[2] || ''; if (frac.length > dec) throw new Error(`Mais de ${dec} casas decimais`); return BigInt(m[1] + frac.padEnd(dec, '0')).toString(); };
  const pctToBps = (s) => { const m = String(s).trim().replace('%', '').replace(',', '.').match(/^(\d{1,3})(?:\.(\d{1,2}))?$/); if (!m) throw new Error(`Percentual inválido: ${s}`); return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || '0'); };
  const parseGrade = (g) => { const m = String(g).match(/^([\d.,]+)\s*\/\s*([\d.,]+)$/); if (!m) throw new Error('Grade inválida (formato X/Y)'); const t = pctToBps(m[1]), p = pctToBps(m[2]); if (!t) throw new Error('Deságio zero'); if (p > t) throw new Error('Y não pode exceder X'); return { totalBps: t, payerBps: p }; };
  const splitBps = (total, parts) => { const each = Math.floor(total / parts); return { shares: Array(parts).fill(each), residual: total - each * parts }; };
  const residualTarget = (policy, lines) => policy === 'TO_PAYER' ? (() => { const p = lines.find((l) => l.kind === 'PAGADOR'); return { roleKey: p.roleKey, roleSeq: p.roleSeq }; })()
    : policy === 'TO_SELL_INTERMEDIARY' ? { roleKey: 'INTERMEDIACAO_VENDA', roleSeq: 1 } : policy === 'TO_BUY_INTERMEDIARY' ? { roleKey: 'INTERMEDIACAO_COMPRA', roleSeq: 1 } : { roleKey: 'PAY_MASTER', roleSeq: 1 };
  function distribute(ref, lines, total, policy) {
    const R = BigInt(ref); const gross = R * BigInt(total); const pool = gross / 10000n;
    const out = lines.map((l) => ({ ...l, amount: (R * BigInt(l.bps)) / 10000n }));
    const assigned = out.reduce((a, l) => a + l.amount, 0n); const residual = pool - assigned;
    if (residual > 0n) { const t = residualTarget(policy, lines); out.push({ lineKey: 'residuo_unidades', label: 'Resíduo de divisão (unidades mínimas)', roleKey: t.roleKey, roleSeq: t.roleSeq, bps: 0, kind: 'RESIDUO', amount: residual }); }
    return { pool, lines: out, residualUnits: residual, truncatedNumerator: Number(gross % 10000n) };
  }
  function templateLines(total, payer, roles, policy) {
    const lines = []; const payerRole = roles.has('COMPRADOR') ? 'COMPRADOR' : 'PAY_MASTER';
    if (payer > 0) lines.push({ lineKey: 'pagador', label: 'Pagador', roleKey: payerRole, roleSeq: 1, bps: payer, kind: 'PAGADOR' });
    const rest = total - payer; if (rest === 0) return lines;
    const inter = ['INTERMEDIACAO_VENDA', 'PAY_MASTER', 'INTERMEDIACAO_COMPRA'].filter((r) => r === 'PAY_MASTER' || roles.has(r));
    const buckets = []; if (roles.has('GRUPO_VENDA')) buckets.push(['grupo_venda', 'Grupo Venda', 'GRUPO_VENDA']); if (roles.has('GRUPO_COMPRA')) buckets.push(['grupo_compra', 'Grupo Compra', 'GRUPO_COMPRA']); buckets.push(['intermediacao', 'Intermediação', null]);
    const { shares, residual } = splitBps(rest, buckets.length); shares[shares.length - 1] += residual;
    buckets.forEach(([k, label, role], i) => {
      if (role) { lines.push({ lineKey: k, label, roleKey: role, roleSeq: 1, bps: shares[i], kind: role }); return; }
      const sp = splitBps(shares[i], inter.length);
      inter.forEach((r, j) => lines.push({ lineKey: `intermediacao_${j + 1}`, label: `Intermediação — ${r === 'PAY_MASTER' ? 'Ligação' : r === 'INTERMEDIACAO_VENDA' ? 'Venda' : 'Compra'}`, roleKey: r, roleSeq: 1, bps: sp.shares[j], kind: 'INTERMEDIACAO' }));
      if (sp.residual > 0) { const t = residualTarget(policy, lines); lines.push({ lineKey: 'intermediacao_residuo', label: 'Resíduo de divisão', roleKey: t.roleKey, roleSeq: t.roleSeq, bps: sp.residual, kind: 'RESIDUO' }); }
    });
    return lines;
  }

  // ------------------------------------------------------------------ catálogos
  const ROLE_LABEL = { VENDEDOR: 'Vendedor', GRUPO_VENDA: 'Grupo Venda', INTERMEDIACAO_VENDA: 'Intermediação Venda', PAY_MASTER: 'Pay Master / Ligação', INTERMEDIACAO_COMPRA: 'Intermediação Compra', GRUPO_COMPRA: 'Grupo Compra', COMPRADOR: 'Comprador' };
  const CHAIN = ['VENDEDOR', 'GRUPO_VENDA', 'INTERMEDIACAO_VENDA', 'PAY_MASTER', 'INTERMEDIACAO_COMPRA', 'GRUPO_COMPRA', 'COMPRADOR'];
  const roleLabel = (k, seq = 1) => (ROLE_LABEL[k] || k) + (seq > 1 ? ' ' + String(seq).padStart(2, '0') : '');
  const STATUS_LABEL = { DRAFT: 'Rascunho', PENDING_SIGNATURES: 'Aguardando aceites', LOCKED: 'Parceria travada', FUNDED: 'Escrow financiado (DEMO)', EXECUTING: 'Em execução', SETTLED: 'Liquidada', EXPIRED: 'Expirada', CANCELLED: 'Cancelada' };
  const HONESTY = 'A Verum NCNDA não verifica existência, autenticidade ou procedência de dinheiro em espécie, fiat ou ativo físico. Pernas fora da plataforma não são protegidas por smart contract.';
  const OFF_CHIP = 'FORA DA PLATAFORMA — NÃO GARANTIDO POR CONTRATO';
  const ASSETS = [
    { id: 'USDT:solana-demo', symbol: 'USDT', name: 'Tether USD (DEMO)', network: 'solana-demo', decimals: 6, legType: 'ONCHAIN', selectable: true },
    { id: 'USDC:solana-demo', symbol: 'USDC', name: 'USD Coin (DEMO)', network: 'solana-demo', decimals: 6, legType: 'ONCHAIN', selectable: true },
    { id: 'SOL:solana-demo', symbol: 'SOL', name: 'Solana (DEMO)', network: 'solana-demo', decimals: 9, legType: 'ONCHAIN', selectable: true },
    { id: 'BTC:bitcoin-demo', symbol: 'BTC', name: 'Bitcoin (DEMO)', network: 'bitcoin-demo', decimals: 8, legType: 'ONCHAIN', selectable: true },
    { id: 'USD:cash', symbol: 'USD', name: 'Dólar em espécie', network: 'offchain', decimals: 2, legType: 'CASH_PHYSICAL', selectable: true },
    { id: 'BRL:fiat', symbol: 'BRL', name: 'Real (transferência bancária/PIX)', network: 'offchain', decimals: 2, legType: 'FIAT_TRANSFER', selectable: true },
    { id: 'PHYSICAL:asset', symbol: 'ATIVO FÍSICO', name: 'Ativo físico (descrição livre)', network: 'offchain', decimals: 0, legType: 'PHYSICAL_ASSET', selectable: true },
    { id: 'USDT:solana-mainnet', symbol: 'USDT', name: 'Tether USD (mainnet — DESLIGADO)', network: 'solana-mainnet', decimals: 6, legType: 'ONCHAIN', selectable: false },
  ];
  const asset = (id) => ASSETS.find((a) => a.id === id);
  const PERSONAS = [
    ['pm01', 'Rafael Monteiro', 'rafael.monteiro@demo.verum', '+55 11 98811-4021', 'BR', 'Pay Master 01 · admin das mesas'],
    ['pm02', 'Helena Duarte', 'helena.duarte@demo.verum', '+595 981 552-310', 'PY', 'Pay Master 02 (DEMO 3)'],
    ['vend', 'Marcos Albuquerque', 'marcos.albuquerque@demo.verum', '+55 21 99702-1188', 'BR', 'Vendedor'],
    ['gv', 'Camila Furtado', 'camila.furtado@demo.verum', '+55 41 99133-7720', 'BR', 'Grupo Venda'],
    ['iv', 'Diego Sampaio', 'diego.sampaio@demo.verum', '+55 31 98455-0293', 'BR', 'Intermediação Venda'],
    ['ic', 'Lívia Moraes', 'livia.moraes@demo.verum', '+55 47 99260-6614', 'BR', 'Intermediação Compra (DEMO 2)'],
    ['gc', 'Tiago Rezende', 'tiago.rezende@demo.verum', '+55 61 99318-4402', 'BR', 'Grupo Compra'],
    ['comp', 'Beatriz Lacerda', 'beatriz.lacerda@demo.verum', '+1 305 555-0144', 'US', 'Comprador'],
  ];
  const personaKey = (k) => nacl.sign.keyPair.fromSeed(nacl.hash(enc(`verum-ncnda-demo-persona:${k}`)).slice(0, 32));
  const personaAddr = (k) => b58enc(personaKey(k).publicKey);
  const personaSign = (k, msg) => b58enc(nacl.sign.detached(enc(msg), personaKey(k).secretKey));

  // ------------------------------------------------------------------ estado
  // v2: as personas DEMO passaram a derivar de "verum-ncnda-demo-persona:" — endereços mudaram.
  // Estado salvo com os endereços antigos não casa mais com a carteira; a chave nova descarta e resemeia.
  const KEY = 'votc-preview-state-v2';
  let S = null;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* sem persistência */ } };
  const load = () => { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  // Migração única: limpa o estado v1 e as carteiras-convidado que ficaram órfãs com ele.
  try {
    if (localStorage.getItem('votc-preview-state-v1')) {
      localStorage.removeItem('votc-preview-state-v1');
      localStorage.removeItem('votc-demo-guests');
    }
  } catch { /* sem persistência */ }
  const err = (status, error, message, extra = {}) => { const e = new Error(message); e.status = status; e.payload = { error, message, ...extra }; return e; };
  const audit = (deal, action, userId, extra = {}) => { deal.audit.push({ id: String(++S.seq), at: nowIso(), action, entity: extra.entity || 'deal', userId: userId || null, wallet: extra.wallet || null, newValue: extra.newValue || null }); };
  const userById = (id) => S.users.find((u) => u.id === id);
  const userByAddr = (a) => S.users.find((u) => u.address === a);
  // DEMO: acesso livre. Qualquer carteira entra; se não tiver cadastro, criamos um na hora.
  // O convidado NÃO entra como membro das mesas: senão quem abre um link de visualização
  // veria todas as mesas (e não só a compartilhada) e poderia aceitar documentos, já que
  // /documents/:vid/accept só exige needMember. Para explorar mesas cheias, entre como persona.
  // O servidor real (src/services/auth.ts) continua exigindo convite — isto vive só aqui.
  function autoRegister(address) {
    const n = S.users.filter((u) => !u.key).length + 1;
    const u = {
      id: uuid(), key: null, name: `Convidado DEMO ${String(n).padStart(2, '0')}`,
      email: `convidado${n}.${address.slice(0, 6).toLowerCase()}@demo.verum`, phone: '+55 11 90000-0000',
      country: 'BR', address, createdAt: nowIso(), deletionRequestedAt: null,
    };
    S.users.push(u);
    return u;
  }
  const dealById = (id) => { const d = S.deals.find((x) => x.id === id); if (!d) throw err(404, 'NOT_FOUND', 'Operação não encontrada.'); return d; };
  // Link de visualização da mesa: um por mesa, só-leitura, gerado e revogado pelo admin (Pay Master 01).
  // Guardado em claro porque o admin precisa poder reexibir e recompartilhar o mesmo link.
  const shareLink = (d) => {
    if (!d.viewToken) d.viewToken = rnd(32).padEnd(43, '1').slice(0, 43);
    return { token: d.viewToken, url: `${ORIGIN}#/m/${d.viewToken}` };
  };
  const sharedDeal = (t) => {
    const d = /^[A-Za-z0-9_-]{43}$/.test(t || '') ? S.deals.find((x) => x.viewToken === t) : null;
    if (!d) throw err(404, 'LINK_INVALID', 'Este link de visualização não é mais válido. Peça um novo ao Pay Master 01.');
    return d;
  };
  // Quem abre o link precisa se identificar antes de ver a operação (padrão NCNDA).
  // Admin e participantes já têm acesso próprio e não passam por esse portão.
  const viewerOf = (d, uid) => d.viewers.find((x) => x.userId === uid) || null;
  const viewerCleared = (d, uid) => d.adminUserId === uid || d.members.includes(uid) || !!viewerOf(d, uid);
  const needViewer = (d, uid) => { if (!viewerCleared(d, uid)) throw err(403, 'VIEWER_REGISTRATION_REQUIRED', 'Identifique-se para abrir esta operação.'); };
  const isMember = (d, uid) => d.adminUserId === uid || d.members.includes(uid);
  const needMember = (d, uid) => { if (!isMember(d, uid)) throw err(404, 'NOT_FOUND', 'Operação não encontrada.'); };
  const needAdmin = (d, uid) => { if (d.adminUserId !== uid) throw err(403, 'FORBIDDEN', 'Ação exclusiva do admin da operação.'); };
  const linesSum = (d) => d.lines.reduce((a, l) => a + l.bps, 0);
  const bpsOf = (d, roleKey, seq) => d.lines.filter((l) => l.roleKey === roleKey && l.roleSeq === seq).reduce((a, l) => a + l.bps, 0);
  const termsHash = (d) => sha(JSON.stringify({ code: d.code, v: d.version.no, grade: [d.gradeTotal, d.gradePayer], policy: d.version.residualPolicy, legs: d.legs, conditions: d.conditions, parts: d.participants.map((p) => [p.roleKey, p.seq, userById(p.userId)?.address || null]), lines: d.lines.map((l) => [l.lineKey, l.roleKey, l.roleSeq, l.bps, l.kind]) }));

  function newDeal(adminId, o) {
    const d = {
      id: uuid(), code: `OTC-${String(++S.dealSeq).padStart(4, '0')}`, isDemo: true, adminUserId: adminId, createdAt: nowIso(),
      kind: o.kind, title: o.title, businessId: o.businessId || null, businessName: o.businessName || null, tagline: o.tagline || null, volume: o.volume,
      reference: o.reference || null, gradeTotal: o.gradeTotal, gradePayer: o.gradePayer, conditions: o.conditions || [], validUntil: o.validUntil || null,
      legs: [{ side: 'ENTREGA', assetId: o.deliver, description: o.deliverDescription || null }, { side: 'RECEBIMENTO', assetId: o.receive, description: null }],
      version: { id: uuid(), no: 1, status: 'DRAFT', residualPolicy: o.policy || 'TO_PAY_MASTER', termsHash: null, lockedAt: null, versionsCount: 1 },
      participants: [], lines: [], signatures: [], settlement: null, documents: [], invitations: [], members: [adminId], audit: [],
      viewToken: null, // link de visualização só-leitura; gerado sob demanda pelo Pay Master 01 (admin)
      viewers: [], // quem se identificou para abrir o link: nome, e-mail, telefone, país e carteira
    };
    audit(d, 'OFFER_CREATED', adminId); audit(d, 'DEAL_CREATED', adminId);
    return d;
  }
  const seatP = (d, roleKey, seq, userId) => { d.participants.push({ id: uuid(), roleKey, seq, userId: userId || null }); if (userId && !d.members.includes(userId)) d.members.push(userId); };

  function seed() {
    S = { seq: 0, dealSeq: 0, users: [], deals: [], challenges: [], session: null, inviteSessions: {} };
    for (const [key, name, email, phone, country] of PERSONAS) S.users.push({ id: uuid(), key, name, email, phone, country, address: personaAddr(key), createdAt: nowIso(), deletionRequestedAt: null });
    const U = Object.fromEntries(S.users.map((u) => [u.key, u.id]));
    const in7 = new Date(Date.now() + 7 * 864e5).toISOString();
    // DEMO 1
    const d1 = newDeal(U.pm01, { kind: 'UNICA', title: 'BTC contra USDT — lote diário', volume: 'Mínimo diário de 350 BTC', deliver: 'BTC:bitcoin-demo', receive: 'USDT:solana-demo', reference: { amount: parseUnits('21437500.123457', 6), assetId: 'USDT:solana-demo' }, gradeTotal: 700, gradePayer: 400, validUntil: in7,
      conditions: ['Modo remoto ou presencial', 'BTC na frente, em tranches a definir', 'Carteira USDT de baixa movimentação (mínimo 30MM) e carteira BTC', 'Handshake obrigatório', 'Sem Satoshi e sem teste AB'] });
    seatP(d1, 'PAY_MASTER', 1, U.pm01); seatP(d1, 'VENDEDOR', 1, U.vend); seatP(d1, 'GRUPO_VENDA', 1, U.gv); seatP(d1, 'INTERMEDIACAO_VENDA', 1, U.iv); seatP(d1, 'INTERMEDIACAO_COMPRA', 1, null); seatP(d1, 'GRUPO_COMPRA', 1, U.gc); seatP(d1, 'COMPRADOR', 1, U.comp);
    d1.lines = [{ lineKey: 'pagador', label: 'Pagador', roleKey: 'COMPRADOR', roleSeq: 1, bps: 400, kind: 'PAGADOR' }, { lineKey: 'grupo_compra', label: 'Compra', roleKey: 'GRUPO_COMPRA', roleSeq: 1, bps: 100, kind: 'GRUPO_COMPRA' }, { lineKey: 'grupo_venda', label: 'Venda', roleKey: 'GRUPO_VENDA', roleSeq: 1, bps: 100, kind: 'GRUPO_VENDA' }, { lineKey: 'intermediacao_venda', label: 'Intermediários — Venda', roleKey: 'INTERMEDIACAO_VENDA', roleSeq: 1, bps: 50, kind: 'INTERMEDIACAO' }, { lineKey: 'intermediacao_compra', label: 'Intermediários — Compra', roleKey: 'INTERMEDIACAO_COMPRA', roleSeq: 1, bps: 50, kind: 'INTERMEDIACAO' }];
    S.deals.push(d1);
    // DEMO 2
    const d2 = newDeal(U.pm01, { kind: 'PERMANENTE', businessId: uuid(), businessName: 'Aurora Commodities', tagline: 'Parceria permanente · ativo físico contra USDT', title: 'Aurora — lote de 10 unidades', volume: '10 unidades', deliver: 'PHYSICAL:asset', deliverDescription: 'Ativo físico (descrição em Documentos)', receive: 'USDT:solana-demo', reference: { amount: parseUnits('1000000.037777', 6), assetId: 'USDT:solana-demo' }, gradeTotal: 2500, gradePayer: 1500,
      conditions: ['Entrega imediata', 'Apresentação de CIS', 'Carteiras USDT para compliance', 'Liberação após validação'] });
    for (const [r, k] of [['PAY_MASTER', 'pm01'], ['VENDEDOR', 'vend'], ['GRUPO_VENDA', 'gv'], ['INTERMEDIACAO_VENDA', 'iv'], ['INTERMEDIACAO_COMPRA', 'ic'], ['GRUPO_COMPRA', 'gc'], ['COMPRADOR', 'comp']]) seatP(d2, r, 1, U[k]);
    d2.lines = templateLines(2500, 1500, new Set(CHAIN), 'TO_PAY_MASTER');
    S.deals.push(d2);
    submit(d2, U.pm01);
    for (const p of d2.participants) { const u = userById(p.userId); const msg = `SIGNATURE OF AGREEMENT ${d2.code} v1 ${d2.version.termsHash}`; recordSignature(d2, p, u, msg, personaSign(u.key, msg)); }
    // DEMO 3
    const d3 = newDeal(U.pm01, { kind: 'UNICA', title: 'Lote físico de 12 unidades', volume: '12 unidades', deliver: 'PHYSICAL:asset', deliverDescription: 'Ativo físico (12 unidades)', receive: 'USDT:solana-demo', reference: { amount: parseUnits('12000000.000001', 6), assetId: 'USDT:solana-demo' }, gradeTotal: 1200, gradePayer: 800, validUntil: new Date(Date.now() + 5 * 864e5).toISOString(),
      conditions: ['Retirada parcial exige saldo compatível na carteira pagadora', 'Retirada integral exige saldo dos 12', 'Avanço condicionado à validação de CIS, carteira pagadora, documentação e compliance'] });
    for (const [r, s, k] of [['PAY_MASTER', 1, 'pm01'], ['PAY_MASTER', 2, 'pm02'], ['VENDEDOR', 1, 'vend'], ['GRUPO_VENDA', 1, 'gv'], ['GRUPO_COMPRA', 1, 'gc'], ['COMPRADOR', 1, 'comp']]) seatP(d3, r, s, U[k]);
    d3.lines = [{ lineKey: 'pagador', label: 'Pagador', roleKey: 'COMPRADOR', roleSeq: 1, bps: 800, kind: 'PAGADOR' }, { lineKey: 'venda_fechada', label: 'Venda fechada', roleKey: 'GRUPO_VENDA', roleSeq: 1, bps: 200, kind: 'GRUPO_VENDA' }, { lineKey: 'compra_intermediarios', label: 'Compra e intermediários', roleKey: 'GRUPO_COMPRA', roleSeq: 1, bps: 200, kind: 'GRUPO_COMPRA' }];
    S.deals.push(d3);
    submit(d3, U.pm01);
    for (const k of ['vend', 'gv', 'pm01', 'pm02', 'gc']) { const u = S.users.find((x) => x.key === k); const p = d3.participants.find((x) => x.userId === u.id); const msg = `SIGNATURE OF AGREEMENT ${d3.code} v1 ${d3.version.termsHash}`; recordSignature(d3, p, u, msg, personaSign(k, msg)); }
    save();
  }
  function submit(d, uid) {
    if (d.version.status !== 'DRAFT') throw err(409, 'INVALID_TRANSITION', 'Só versões em DRAFT podem ir para assinatura.');
    if (d.invitations.some((i) => ['ATIVO', 'ABERTO'].includes(i.status))) throw err(409, 'LIVE_INVITES', 'Existem convites em aberto nesta versão. Aguarde a conclusão ou revogue.');
    if (linesSum(d) !== d.gradeTotal) throw err(400, 'BPS_SUM_MISMATCH', 'A soma das linhas não fecha com o deságio total da grade. A parceria não pode sair de DRAFT.');
    if (d.participants.some((p) => !p.userId)) throw err(400, 'PARTICIPANTS_INCOMPLETE', 'Há funções sem parceiro cadastrado. Gere os convites e aguarde a conclusão.');
    d.version.termsHash = termsHash(d); d.version.status = 'PENDING_SIGNATURES';
    audit(d, 'VERSION_SUBMITTED', uid, { entity: 'partnership_version', newValue: { terms_hash: d.version.termsHash } });
  }
  function recordSignature(d, p, u, message, signature) {
    d.signatures.push({ participantId: p.id, userId: u.id, wallet: u.address, termsHash: d.version.termsHash, versionNo: d.version.no, message, signature, at: nowIso() });
    audit(d, 'AGREEMENT_SIGNED', u.id, { entity: 'partnership_version', wallet: u.address });
    const k = validSigs(d).length;
    if (k === d.participants.length) { d.version.status = 'LOCKED'; d.version.lockedAt = nowIso(); audit(d, 'DEAL_LOCKED', u.id, { entity: 'partnership_version', newValue: { status: 'LOCKED' } }); }
  }
  const validSigs = (d) => d.signatures.filter((s) => s.termsHash === d.version.termsHash && s.versionNo === d.version.no && d.participants.some((p) => p.id === s.participantId));

  // ------------------------------------------------------------------ views (mesmo formato do servidor)
  // shared = acesso por link de visualização: dispensa pertencimento, mas zera tudo que é ação.
  function dealView(d, uid, shared = false) {
    if (!shared) needMember(d, uid);
    const viewerId = shared ? null : uid;
    const isAdmin = !shared && d.adminUserId === uid;
    const refA = d.reference ? asset(d.reference.assetId) : null;
    const legs = d.legs.map((l) => { const a = asset(l.assetId); return { side: l.side, assetId: l.assetId, symbol: a.symbol, name: a.name, description: l.description, legType: a.legType, onchain: a.legType === 'ONCHAIN', chip: a.legType === 'ONCHAIN' ? 'ON-CHAIN' : OFF_CHIP }; });
    const off = legs.some((l) => !l.onchain);
    const sigs = validSigs(d); const signed = new Set(sigs.map((s) => s.participantId));
    const parts = [...d.participants].sort((a, b) => ((a.roleKey === 'PAY_MASTER' ? 0 : 1) - (b.roleKey === 'PAY_MASTER' ? 0 : 1)) || (CHAIN.indexOf(a.roleKey) - CHAIN.indexOf(b.roleKey)) || (a.seq - b.seq));
    const pmCount = parts.filter((p) => p.roleKey === 'PAY_MASTER').length;
    const participants = parts.map((p) => {
      const u = p.userId ? userById(p.userId) : null; const bps = bpsOf(d, p.roleKey, p.seq); const visible = !!u && d.members.includes(u.id);
      const inv = d.invitations.filter((i) => i.participantId === p.id).slice(-1)[0];
      return { id: p.id, roleKey: p.roleKey, seq: p.seq, role: roleLabel(p.roleKey, p.seq), isPayMaster: p.roleKey === 'PAY_MASTER', payMasterBadge: p.roleKey === 'PAY_MASTER' ? (pmCount > 1 ? `PAY MASTER ${String(p.seq).padStart(2, '0')}` : 'PAY MASTER') : null,
        filled: !!u, isMe: !!u && u.id === viewerId, name: u?.name || null, email: visible ? u.email : null, phone: visible ? u.phone : null, contactVisible: visible,
        wallet: u?.address || null, walletShort: u ? `${u.address.slice(0, 4)}...${u.address.slice(-4)}` : '—', bps, bpsLabel: fmtBps(bps), signed: signed.has(p.id),
        invite: isAdmin && inv ? { id: inv.id, status: inv.status } : null };
    });
    const me = participants.find((p) => p.isMe);
    const sum = linesSum(d);
    const errors = sum !== d.gradeTotal ? [`Soma das linhas (${fmtBps(Math.min(sum, 10000))}) diferente do deságio total da grade (${fmtBps(d.gradeTotal)})`] : [];
    const deliver = legs.find((l) => l.side === 'ENTREGA'), receive = legs.find((l) => l.side === 'RECEBIMENTO');
    return {
      id: d.id, code: d.code, isDemo: true, isAdmin, createdAt: d.createdAt,
      readOnly: shared, sharedToken: shared ? d.viewToken : null,
      offer: { id: d.id, kind: d.kind, kindLabel: d.kind === 'UNICA' ? 'OFERTA ÚNICA' : 'PARCERIA PERMANENTE', title: d.title, businessId: d.businessId, businessName: d.businessName, tagline: d.tagline, volume: d.volume,
        reference: d.reference ? { amount: d.reference.amount, assetId: refA.id, symbol: refA.symbol, decimals: refA.decimals, label: `${fmtUnits(d.reference.amount, refA.decimals, true)} ${refA.symbol}` } : null,
        grade: { totalBps: d.gradeTotal, payerBps: d.gradePayer, label: fmtGrade(d.gradeTotal, d.gradePayer), discountLabel: fmtBps(d.gradeTotal) },
        conditions: d.conditions, validUntil: d.validUntil, expired: d.validUntil ? new Date(d.validUntil) <= new Date() : false },
      legs, direction: `${deliver.symbol} → ${receive.symbol}`, hasOffPlatformLeg: off, honestyNotice: off ? HONESTY : null,
      version: { ...d.version, statusLabel: STATUS_LABEL[d.version.status], editable: d.version.status === 'DRAFT', gradeTotalBps: d.gradeTotal },
      lines: d.lines.map((l) => ({ ...l, bpsLabel: fmtBps(l.bps), role: l.roleKey ? roleLabel(l.roleKey, l.roleSeq) : null })),
      linesValidation: { ok: errors.length === 0, sum, expected: d.gradeTotal, errors },
      participants, signatures: { k: sigs.length, n: d.participants.length, label: `${sigs.length}/${d.participants.length} CONFIRMADOS` },
      me: me ? { participantId: me.id, signed: me.signed, role: me.role } : null,
      settlement: d.settlement ? settlementView(d) : null,
      payment: { mode: 'DIRECT', label: 'PAGAMENTO DIRETO À CARTEIRA DO PARCEIRO — fora do escrow' },
      settlementAdapter: { id: 'DEMO_SIMULATED', demo: true, protectedByContract: false },
    };
  }
  // Payloads das sub-rotas da mesa, sem autorização embutida: cada rota decide quem pode chamar.
  // Reaproveitados tal e qual pelas rotas /api/shared/:token (só-leitura).
  const historyOut = (d) => ({ events: d.audit.map((a) => ({ id: a.id, at: a.at, action: a.action, entity: a.entity, actor: a.userId ? userById(a.userId)?.name || 'Participante' : 'Sistema', walletShort: a.wallet ? `${a.wallet.slice(0, 4)}...${a.wallet.slice(-4)}` : null })) });
  function complianceOut(d) {
    const req = d.documents.filter((x) => x.requiresAcceptance).length;
    return { notice: 'Status apenas informativos. A Verum NCNDA não emite aprovação regulatória nem garante legalidade de operações.', items: d.participants.map((x) => { const u = x.userId ? userById(x.userId) : null; const st = [u ? 'Carteira apresentada' : 'Informação pendente']; if (req) st.push(d.documents.filter((doc) => doc.requiresAcceptance && doc.acceptedBy.includes(x.userId)).length >= req ? 'Documento recebido' : 'Revisão necessária'); return { role: roleLabel(x.roleKey, x.seq), name: u?.name || null, statuses: st }; }) };
  }
  // Cards de quem abriu o link: exatamente o que a pessoa preencheu, mais a carteira que assinou.
  const COUNTRY_LABEL = { BR: 'Brasil', PY: 'Paraguai', AR: 'Argentina', UY: 'Uruguai', US: 'Estados Unidos', PT: 'Portugal', AE: 'Emirados Árabes', CH: 'Suíça' };
  const viewersOut = (d) => ({
    hasLink: !!d.viewToken,
    viewers: [...d.viewers].reverse().map((v) => ({
      id: v.id, name: v.name, email: v.email, phone: v.phone, country: v.country, countryLabel: COUNTRY_LABEL[v.country] || v.country,
      wallet: v.address, walletShort: `${v.address.slice(0, 4)}...${v.address.slice(-4)}`, at: v.at,
      isParticipant: d.participants.some((x) => x.userId === v.userId),
    })),
  });
  const documentsOut = (d, uid) => ({ documents: d.documents.map((x) => ({ documentId: x.documentId, name: x.name, versionId: x.id, versionNo: x.versionNo, sha256: x.hash, mime: x.mime, size: x.size, requiresAcceptance: x.requiresAcceptance, createdAt: x.createdAt, isLatest: x.isLatest, status: !x.isLatest ? 'SUBSTITUÍDO' : (x.requiresAcceptance ? 'AGUARDANDO ACEITE' : 'INFORMATIVO'), acceptedBy: x.acceptedBy.map((u) => ({ name: userById(u)?.name })), iAccepted: uid ? x.acceptedBy.includes(uid) : false, downloadUrl: `data:${x.mime};base64,${x.content}` })) });
  function settlementView(d) {
    const st = d.settlement; const a = asset(st.assetId); const f = (x) => `${fmtUnits(x, a.decimals)} ${a.symbol}`;
    return { id: st.id, status: st.status, adapter: 'DEMO_SIMULATED', symbol: a.symbol, referenceAmount: st.referenceAmount, referenceLabel: f(st.referenceAmount), poolAmount: st.poolAmount, poolLabel: f(st.poolAmount), residualUnits: st.residualUnits, residualLabel: f(st.residualUnits), truncatedNumerator: st.truncatedNumerator,
      truncatedLabel: st.truncatedNumerator > 0 ? `${st.truncatedNumerator}/10000 da unidade mínima (abaixo da menor unidade do ativo — não distribuível)` : null,
      lines: st.lines.map((l) => ({ ...l, amountLabel: f(l.amount), bpsLabel: fmtBps(l.bps), role: l.roleKey ? roleLabel(l.roleKey, l.roleSeq) : null })), createdAt: st.createdAt, settledAt: st.settledAt };
  }
  function previewSettlement(d) {
    if (!d.reference) throw err(400, 'NO_REFERENCE', 'A oferta não tem valor de referência: não há base para distribuição.');
    const a = asset(d.reference.assetId); const dist = distribute(d.reference.amount, d.lines, d.gradeTotal, d.version.residualPolicy); const f = (x) => `${fmtUnits(x, a.decimals)} ${a.symbol}`;
    return { adapter: 'DEMO_SIMULATED', demo: true, protectedByContract: false, referenceLabel: f(d.reference.amount), poolLabel: f(dist.pool), residualLabel: f(dist.residualUnits), truncatedNumerator: dist.truncatedNumerator,
      lines: dist.lines.map((l) => ({ ...l, amount: l.amount.toString(), amountLabel: f(l.amount), bpsLabel: fmtBps(l.bps), role: l.roleKey ? roleLabel(l.roleKey, l.roleSeq) : null })), dist };
  }
  const listItem = (d, uid) => { const v = dealView(d, uid); return { id: v.id, code: v.code, isDemo: true, isAdmin: v.isAdmin, offer: v.offer, legs: v.legs, direction: v.direction, hasOffPlatformLeg: v.hasOffPlatformLeg, honestyNotice: v.honestyNotice, version: v.version, lines: v.lines, linesValidation: v.linesValidation, signatures: v.signatures, settlementStatus: v.settlement?.status || null }; };
  const myDeals = (uid) => S.deals.filter((d) => isMember(d, uid));

  // ------------------------------------------------------------------ challenges
  function challenge(purpose, address, context) {
    const nonce = rnd(24); const id = uuid(); const issued = new Date(); const exp = new Date(issued.getTime() + 120000);
    const lines = ['VERUM NCNDA', purpose === 'INVITE' ? 'Prova de posse de carteira (convite)' : purpose === 'LOGIN' ? 'Prova de posse de carteira (login)' : purpose === 'AGREEMENT' ? 'SIGNATURE OF AGREEMENT — aceite da parceria' : purpose === 'DOCUMENT' ? 'Aceite de documento' : 'AUTORIZAR LIQUIDAÇÃO', `Domínio: ${ORIGIN}`, `Carteira: ${address}`];
    for (const k of Object.keys(context).sort()) lines.push(`${k}: ${context[k]}`);
    lines.push(`Nonce: ${nonce}`, `Emitido em: ${issued.toISOString()}`, `Expira em: ${exp.toISOString()}`, purpose === 'SETTLEMENT' ? 'Esta assinatura autoriza a liquidação descrita acima.' : 'Esta assinatura NÃO autoriza transação e NÃO movimenta fundos.');
    const message = lines.join('\n');
    S.challenges.push({ id, purpose, address, context, message, nonceHash: sha(nonce), expiresAt: exp.toISOString(), consumed: false });
    save();
    return { challengeId: id, message, nonce, expiresAt: exp.toISOString() };
  }
  function consume(body, purpose) {
    const fail = () => err(401, 'SIGNATURE_INVALID', 'Assinatura inválida ou expirada. Gere um novo desafio.');
    const ch = S.challenges.find((c) => c.id === body.challengeId);
    if (!ch || ch.consumed || new Date(ch.expiresAt) <= new Date() || ch.purpose !== purpose) throw fail();
    ch.consumed = true; save();
    if (sha(String(body.nonce || '')) !== ch.nonceHash) throw fail();
    let ok = false; try { ok = nacl.sign.detached.verify(enc(ch.message), b58dec(String(body.signature)), b58dec(ch.address)); } catch { ok = false; }
    if (!ok) throw fail();
    return ch;
  }
  const session = () => { if (!S.session) throw err(401, 'UNAUTHENTICATED', 'Sessão expirada. Entre com a Verum Wallet.'); return S.session; };

  // ------------------------------------------------------------------ convites
  const inviteMsg = (d, role, link, code) => ['VERUM NCNDA — Convite privado', `Operação: ${d.code} · Função: ${role}`, `Link (uso único): ${link}`, `Código: ${code}`, 'Para entrar você precisa da Verum Wallet (carteira de autocustódia, as chaves ficam só com você). Se ainda não tem, peça o link de download ao responsável pela mesa.', 'Atenção: o convite só pode ser aberto UMA vez. Se abrir sem a carteira instalada, peça um novo link.'].join('\n');
  function inviteOut(d, inv, token, code) {
    const role = roleLabel(inv.roleKey, inv.roleSeq); const link = `${ORIGIN}#/i/${token}`;
    return { invitation: { id: inv.id, status: inv.status, roleKey: inv.roleKey, roleSeq: inv.roleSeq, role, bps: inv.bps, bpsLabel: fmtBps(inv.bps), createdAt: inv.createdAt, expiresAt: inv.expiresAt }, link, code, message: inviteMsg(d, role, link, code) };
  }
  function createInvite(d, uid, roleKey, roleSeq, ttl) {
    needAdmin(d, uid);
    if (d.version.status !== 'DRAFT') throw err(409, 'VERSION_LOCKED', 'Parceria fora de DRAFT: convites só podem ser gerados dentro de uma nova versão.');
    const slot = d.participants.find((p) => p.roleKey === roleKey && p.seq === roleSeq);
    if (!slot) throw err(400, 'SLOT_NOT_FOUND', 'Essa função não existe na versão atual da parceria.');
    if (slot.userId) throw err(409, 'SLOT_FILLED', 'Essa função já está ocupada por um parceiro cadastrado.');
    if (d.invitations.some((i) => i.participantId === slot.id && ['ATIVO', 'ABERTO'].includes(i.status))) throw err(409, 'LIVE_INVITE_EXISTS', 'Já existe um convite ativo para essa função. Revogue ou gere novo link.');
    const token = rnd(32).padEnd(43, '1').slice(0, 43); const code = newCode();
    const inv = { id: uuid(), dealId: d.id, participantId: slot.id, roleKey, roleSeq, bps: bpsOf(d, roleKey, roleSeq), tokenHash: sha(token), codeHash: sha('pepper:' + code), status: 'ATIVO', failed: 0, createdAt: nowIso(), expiresAt: new Date(Date.now() + (ttl || 24) * 3600e3).toISOString(), openedAt: null, session: null, codeVerified: false, walletVerified: false, pendingAddress: null, userId: null, completedAt: null, replacedById: null };
    d.invitations.push(inv); audit(d, 'INVITE_CREATED', uid, { entity: 'invitation', newValue: { role_key: roleKey, bps: inv.bps } }); audit(d, 'PARTICIPANT_INVITED', uid, { entity: 'partnership_participant' });
    save();
    return inviteOut(d, inv, token, code);
  }
  const sweep = () => { const now = Date.now(); for (const d of S.deals) for (const i of d.invitations) { if ((i.status === 'ATIVO' && new Date(i.expiresAt) <= now) || (i.status === 'ABERTO' && Math.min(new Date(i.openedAt).getTime() + 10 * 60e3, new Date(i.expiresAt).getTime()) <= now)) { i.status = 'EXPIRADO'; audit(d, 'INVITE_EXPIRED', null, { entity: 'invitation' }); } } };
  const findInv = (token) => { if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null; const h = sha(token); for (const d of S.deals) for (const i of d.invitations) if (i.tokenHash === h) return { d, i }; return null; };
  function openInv(token) {
    sweep(); const f = findInv(token);
    if (!f || f.i.status !== 'ATIVO') throw err(404, 'INVITE_INVALID', GENERIC);
    const sess = rnd(16); f.i.status = 'ABERTO'; f.i.openedAt = nowIso(); f.i.session = sha(sess); S.inviteSessions[f.i.id] = sess;
    audit(f.d, 'INVITE_OPENED', null, { entity: 'invitation' }); save();
    return { step: 'CHOICE', walletDownloadUrl: null };
  }
  function requireOpen(token) {
    sweep(); const f = findInv(token);
    if (!f || f.i.status !== 'ABERTO' || !S.inviteSessions[f.i.id] || sha(S.inviteSessions[f.i.id]) !== f.i.session) throw err(404, 'INVITE_INVALID', GENERIC);
    return f;
  }
  function summary(d, i) {
    return { dealCode: d.code, title: d.title, kind: d.kind, volume: d.volume, direction: { deliver: d.legs[0].assetId, receive: d.legs[1].assetId }, grade: { totalBps: d.gradeTotal, payerBps: d.gradePayer }, role: roleLabel(i.roleKey, i.roleSeq), roleKey: i.roleKey, bps: i.bps, bpsLabel: fmtBps(i.bps),
      participants: d.participants.map((p) => { const u = p.userId ? userById(p.userId) : null; return { role: roleLabel(p.roleKey, p.seq), name: u?.name || null, email: u ? `${u.email[0]}***@${u.email.split('@')[1]}` : null, phone: u ? `+** ** *****-${u.phone.replace(/\D/g, '').slice(-4)}` : null }; }) };
  }
  const stepOf = (i) => !i.codeVerified ? 'CHOICE' : !i.walletVerified ? 'WALLET' : !i.userId ? 'SIGNUP' : 'TERMS';
  const validateSignup = (b) => { const errs = []; const name = String(b.fullName || '').trim().replace(/\s+/g, ' '); if (name.length < 5 || name.split(' ').length < 2) errs.push('Nome completo inválido (nome e sobrenome).'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(b.email || ''))) errs.push('E-mail inválido.'); if (String(b.phone || '').replace(/\D/g, '').length < 8) errs.push('Telefone inválido.'); if (!/^[A-Z]{2}$/.test(String(b.country || ''))) errs.push('País inválido.'); return errs; };

  // ------------------------------------------------------------------ roteador
  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/?]+)') + '(\\?.*)?$'), fn });
  const ok = (data) => ({ status: 200, data });

  on('GET', '/api/config', () => ok({ demoMode: true, network: 'solana-demo', mainnetEnabled: false, walletDownloadUrl: null, resumeWindowMinutes: 10, onboardingTtlMinutes: 10, walletAttestationAvailable: false, walletDeepLinkAvailable: false, preview: true, settlement: { adapter: 'DEMO_SIMULATED', demo: true, protectedByContract: false } }));
  on('GET', '/api/demo/personas', () => ok({ personas: PERSONAS.map(([key, name, , , , hint]) => ({ key, name, hint, address: personaAddr(key) })), warning: 'DEMO' }));
  on('POST', '/auth/wallet-challenge', (b) => ok(challenge('LOGIN', b.address, { Finalidade: 'Entrar na mesa privada' })));
  on('POST', '/auth/wallet-verify', (b) => { const ch = consume(b, 'LOGIN'); const u = userByAddr(ch.address) || autoRegister(ch.address); S.session = { uid: u.id, addr: u.address }; save(); return ok({ ok: true }); });
  on('POST', '/auth/logout', () => { S.session = null; save(); return ok({ ok: true }); });
  on('GET', '/api/me', () => { const u = userById(session().uid); return ok({ id: u.id, fullName: u.name, email: u.email, phone: u.phone, country: u.country, isDemo: true, wallet: u.address, deletionRequestedAt: u.deletionRequestedAt }); });
  on('POST', '/api/me/deletion-request', () => { const u = userById(session().uid); u.deletionRequestedAt = u.deletionRequestedAt || nowIso(); const retained = S.deals.filter((d) => d.participants.some((p) => p.userId === u.id) && d.version.status !== 'DRAFT').map((d) => d.code); save(); return ok({ requested: true, retainedFor: retained, explanation: retained.length ? 'Pedido registrado. Dados vinculados a operações assinadas, travadas ou auditadas são mantidos enquanto durar a obrigação de registro (LGPD). Os demais dados serão excluídos.' : 'Pedido registrado. Seus dados serão excluídos.' }); });
  on('GET', '/api/assets', () => { session(); return ok({ assets: ASSETS }); });
  on('GET', '/api/businesses', () => { const s = session(); const seen = new Map(); for (const d of S.deals) if (d.businessId && d.adminUserId === s.uid) seen.set(d.businessId, { id: d.businessId, name: d.businessName, tagline: d.tagline }); return ok({ businesses: [...seen.values()] }); });
  on('GET', '/api/deals', () => { const s = session(); return ok({ deals: myDeals(s.uid).map((d) => listItem(d, s.uid)) }); });
  on('GET', '/api/dashboard', () => {
    const s = session(); const deals = myDeals(s.uid).map((d) => listItem(d, s.uid));
    const activity = myDeals(s.uid).flatMap((d) => d.audit.map((a) => ({ ...a, dealCode: d.code }))).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 12);
    return ok({ counters: { active: deals.filter((d) => ['LOCKED', 'FUNDED', 'EXECUTING'].includes(d.version.status)).length, awaiting: deals.filter((d) => ['DRAFT', 'PENDING_SIGNATURES'].includes(d.version.status)).length, partnerships: deals.filter((d) => d.offer.kind === 'PERMANENTE').length, settled: deals.filter((d) => d.version.status === 'SETTLED').length }, deals, activity });
  });
  on('POST', '/api/deals', (b) => {
    const s = session();
    const g = parseGrade(b.grade); const dl = asset(b.deliverAssetId), rc = asset(b.receiveAssetId);
    if (!dl || !rc || !dl.selectable || !rc.selectable) throw err(400, 'ASSET_REJECTED', 'Ativo fora do registro ou desligado (mainnet exige autorização explícita).');
    if (dl.id === rc.id) throw err(400, 'DIRECTION_INVALID', 'Ativo ofertado e recebido devem ser diferentes.');
    if ((b.conditions || []).length > 5) throw err(400, 'CONDITIONS', 'Máximo de 5 linhas de condições.');
    let reference = null; if (b.referenceAmount) { const ra = asset(b.referenceAssetId); if (!ra || ra.legType !== 'ONCHAIN') throw err(400, 'REFERENCE_ASSET_INVALID', 'Valor de referência exige ativo on-chain.'); reference = { amount: parseUnits(b.referenceAmount, ra.decimals), assetId: ra.id }; }
    const roles = new Set((b.roles || CHAIN).filter((r) => r !== 'PAY_MASTER')); roles.add('PAY_MASTER');
    let businessId = null, businessName = null, tagline = null, inherit = null;
    if (b.kind === 'PERMANENTE') {
      if (b.businessId) { const src = S.deals.filter((d) => d.businessId === b.businessId).slice(-1)[0]; if (!src) throw err(404, 'NOT_FOUND', 'Negócio não encontrado.'); if (src.adminUserId !== s.uid) throw err(403, 'FORBIDDEN', 'Só o admin do Negócio cria novas ofertas nele.'); businessId = src.businessId; businessName = src.businessName; tagline = src.tagline; inherit = S.deals.filter((d) => d.businessId === businessId && ['LOCKED', 'FUNDED', 'EXECUTING', 'SETTLED'].includes(d.version.status)).slice(-1)[0] || null; }
      else { if (!b.businessName || b.businessName.trim().length < 2) throw err(400, 'BUSINESS_NAME', 'Informe o nome do Negócio.'); businessId = uuid(); businessName = b.businessName.trim(); tagline = b.businessTagline || null; }
    }
    const d = newDeal(s.uid, { kind: b.kind, title: b.title, businessId, businessName, tagline, volume: b.volumeText, deliver: dl.id, deliverDescription: b.deliverDescription, receive: rc.id, reference, gradeTotal: g.totalBps, gradePayer: g.payerBps, conditions: (b.conditions || []).map((c) => c.trim()).filter(Boolean), validUntil: b.validUntil || null, policy: b.residualPolicy });
    if (inherit) { for (const p of inherit.participants) seatP(d, p.roleKey, p.seq, p.userId); d.lines = inherit.gradeTotal === g.totalBps ? inherit.lines.map((l) => ({ ...l })) : templateLines(g.totalBps, g.payerBps, new Set(inherit.participants.map((p) => p.roleKey)), d.version.residualPolicy); }
    else { for (let i = 1; i <= Math.min(Math.max(b.payMasters || 1, 1), 2); i++) seatP(d, 'PAY_MASTER', i, i === 1 ? s.uid : null); for (const r of roles) if (r !== 'PAY_MASTER') seatP(d, r, 1, null); d.lines = templateLines(g.totalBps, g.payerBps, roles, d.version.residualPolicy); }
    S.deals.push(d); save();
    return ok({ dealId: d.id, code: d.code, versionId: d.version.id, inherited: !!inherit });
  });
  on('GET', '/api/deals/:id', (b, p) => { const s = session(); return ok(dealView(dealById(p.id), s.uid)); });

  // ---- link de visualização da mesa -------------------------------------------
  // Gerar/ver/regerar: exclusivo do admin da mesa (Pay Master 01), via needAdmin.
  on('GET', '/api/deals/:id/share-link', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); return ok(d.viewToken ? { ...shareLink(d), exists: true } : { token: null, url: null, exists: false }); });
  on('POST', '/api/deals/:id/share-link', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); const first = !d.viewToken; const out = shareLink(d); if (first) audit(d, 'VIEW_LINK_CREATED', s.uid, { entity: 'deal', wallet: s.addr }); save(); return ok({ ...out, exists: true }); });
  on('POST', '/api/deals/:id/share-link/regenerate', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); d.viewToken = null; const out = shareLink(d); audit(d, 'VIEW_LINK_REVOKED', s.uid, { entity: 'deal', wallet: s.addr }); save(); return ok({ ...out, exists: true }); });

  // Lista de quem abriu o link. Exclusiva do admin da mesa (Pay Master 01).
  on('GET', '/api/deals/:id/viewers', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); return ok(viewersOut(d)); });

  // Portão do link: antes de ver qualquer coisa da operação, a pessoa se identifica.
  // O gate devolve só o cabeçalho da mesa (código, título, direção) — nada de participantes,
  // percentuais ou documentos vaza antes do cadastro.
  on('GET', '/api/shared/:token/gate', (b, p) => {
    const s = session(); const d = sharedDeal(p.token);
    const dl = asset(d.legs.find((l) => l.side === 'ENTREGA').assetId), rc = asset(d.legs.find((l) => l.side === 'RECEBIMENTO').assetId);
    const u = userById(s.uid);
    return ok({
      registered: viewerCleared(d, s.uid), wallet: s.addr, walletShort: `${s.addr.slice(0, 4)}...${s.addr.slice(-4)}`,
      prefill: u && !u.key ? null : { fullName: u?.name || '', email: u?.email || '', phone: u?.phone || '', country: u?.country || 'BR' },
      deal: { code: d.code, title: d.title, businessName: d.businessName, kindLabel: d.kind === 'UNICA' ? 'OFERTA ÚNICA' : 'PARCERIA PERMANENTE', direction: `${dl.symbol} → ${rc.symbol}` },
    });
  });
  on('POST', '/api/shared/:token/register', (b, p) => {
    const s = session(); const d = sharedDeal(p.token);
    const errs = validateSignup(b); if (errs.length) throw err(400, 'VALIDATION', errs.join(' '));
    if (viewerOf(d, s.uid)) throw err(409, 'ALREADY_REGISTERED', 'Você já se identificou para esta operação.');
    const v = { id: uuid(), userId: s.uid, name: String(b.fullName).trim().replace(/\s+/g, ' '), email: String(b.email).trim().toLowerCase(), phone: String(b.phone).trim(), country: b.country, address: s.addr, at: nowIso() };
    d.viewers.push(v);
    // Convidado DEMO (cadastro automático, sem persona): aproveita os dados reais no perfil.
    // Persona ou parceiro com convite concluído mantém o cadastro dele intacto.
    const u = userById(s.uid);
    if (u && !u.key) { u.name = v.name; u.email = v.email; u.phone = v.phone; u.country = v.country; }
    audit(d, 'VIEW_LINK_ACCESSED', s.uid, { entity: 'deal', wallet: s.addr });
    save(); return ok({ ok: true });
  });

  // Visualização por link: exige sessão (carteira) e identificação, dispensa pertencimento.
  // Só GET — nenhuma rota de escrita aceita token, então quem abre o link não tem como agir.
  const shared = (token) => { const s = session(); const d = sharedDeal(token); needViewer(d, s.uid); return { s, d }; };
  on('GET', '/api/shared/:token', (b, p) => { const { s, d } = shared(p.token); return ok(dealView(d, s.uid, true)); });
  on('GET', '/api/shared/:token/history', (b, p) => ok(historyOut(shared(p.token).d)));
  on('GET', '/api/shared/:token/compliance', (b, p) => ok(complianceOut(shared(p.token).d)));
  on('GET', '/api/shared/:token/documents', (b, p) => ok(documentsOut(shared(p.token).d, null)));
  on('GET', '/api/shared/:token/settlement/preview', (b, p) => { const pv = previewSettlement(shared(p.token).d); delete pv.dist; return ok(pv); });
  on('GET', '/api/deals/:id/history', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); return ok(historyOut(d)); });
  on('GET', '/api/audit', () => { const s = session(); return ok({ events: S.deals.filter((d) => d.adminUserId === s.uid).flatMap((d) => d.audit.map((a) => ({ id: a.id, at: a.at, action: a.action, entity: a.entity, wallet: a.wallet ? `${a.wallet.slice(0, 4)}...${a.wallet.slice(-4)}` : null, dealCode: d.code }))).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 300) }); });
  on('GET', '/api/deals/:id/compliance', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); return ok(complianceOut(d)); });
  on('GET', '/api/deals/:id/qr/:pid', (b, p) => {
    const s = session(); const d = dealById(p.id); const v = dealView(d, s.uid); const part = v.participants.find((x) => x.id === p.pid);
    if (!part || !part.wallet) throw err(404, 'NOT_FOUND', 'Parceiro sem carteira cadastrada.');
    const a = d.reference ? asset(d.reference.assetId) : null; let amount = null;
    if (d.reference && v.linesValidation.ok) { const dist = distribute(d.reference.amount, d.lines, d.gradeTotal, d.version.residualPolicy); amount = dist.lines.filter((l) => l.roleKey === part.roleKey && l.roleSeq === part.seq).reduce((x, l) => x + l.amount, 0n); if (amount === 0n) amount = null; }
    audit(d, 'QR_VIEWED', s.uid, { entity: 'partnership_participant' }); save();
    return ok({ uri: `solana:${part.wallet}?label=${encodeURIComponent('DEMO — NO REAL FUNDS')}&message=${encodeURIComponent(`${d.code} ${part.role}`)}`, format: 'SOLANA_PAY', demo: true, network: a?.network || 'solana-demo', asset: a ? { id: a.id, symbol: a.symbol } : null, amount: amount?.toString() || null, amountLabel: amount && a ? `${fmtUnits(amount, a.decimals)} ${a.symbol}` : null, address: part.wallet, addressShort: part.walletShort, name: part.name, role: part.role, payment: v.payment, deepLink: null });
  });
  on('PUT', '/api/deals/:id/lines', (b, p) => {
    const s = session(); const d = dealById(p.id); needAdmin(d, s.uid);
    if (d.version.status !== 'DRAFT') throw err(409, 'VERSION_LOCKED', 'Parceria fora de DRAFT: alterações só em uma nova versão.');
    const slots = new Set(d.participants.map((x) => `${x.roleKey}#${x.seq}`));
    for (const l of b.lines) { if (!Number.isInteger(l.bps) || l.bps < 0 || l.bps > 10000) throw err(400, 'LINES_INVALID', 'bps deve ser inteiro entre 0 e 10000.'); if (l.roleKey && !slots.has(`${l.roleKey}#${l.roleSeq || 1}`)) throw err(400, 'LINES_INVALID', `A linha "${l.label}" aponta para uma função sem cadeira.`); }
    const live = d.invitations.filter((i) => ['ATIVO', 'ABERTO'].includes(i.status));
    for (const i of live) { const nb = b.lines.filter((l) => l.roleKey === i.roleKey && (l.roleSeq || 1) === i.roleSeq).reduce((a, l) => a + l.bps, 0); if (nb !== i.bps) throw err(409, 'LIVE_INVITE_BPS', `${roleLabel(i.roleKey, i.roleSeq)} tem convite ativo com ${fmtBps(i.bps)} travado. Revogue o convite antes de mudar esse percentual.`); }
    d.lines = b.lines.map((l) => ({ lineKey: l.lineKey, label: String(l.label).trim(), roleKey: l.roleKey || null, roleSeq: l.roleSeq || 1, bps: l.bps, kind: l.kind }));
    if (b.residualPolicy) d.version.residualPolicy = b.residualPolicy;
    audit(d, 'ALLOCATION_CHANGED', s.uid, { entity: 'partnership_version' }); save();
    const sum = linesSum(d); return ok({ validation: { ok: sum === d.gradeTotal, sum, expected: d.gradeTotal, errors: sum === d.gradeTotal ? [] : ['Soma não fecha'] } });
  });
  on('POST', '/api/deals/:id/slots', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'DRAFT') throw err(409, 'VERSION_LOCKED', 'Participantes só mudam em DRAFT.'); const n = d.participants.filter((x) => x.roleKey === b.roleKey).length; if (b.roleKey !== 'PAY_MASTER' && n >= 1) throw err(409, 'ROLE_EXISTS', 'Essa função já tem cadeira nesta versão.'); if (b.roleKey === 'PAY_MASTER' && n >= 2) throw err(409, 'ROLE_EXISTS', 'Máximo de 2 Pay Masters.'); seatP(d, b.roleKey, n + 1, null); audit(d, 'ALLOCATION_CHANGED', s.uid, { entity: 'partnership_participant' }); save(); return ok({ participantId: d.participants.slice(-1)[0].id }); });
  on('DELETE', '/api/deals/:id/slots/:pid', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'DRAFT') throw err(409, 'VERSION_LOCKED', 'Participantes só mudam em DRAFT.'); const x = d.participants.find((q) => q.id === p.pid); if (!x) throw err(404, 'NOT_FOUND', 'Cadeira não encontrada.'); if (x.roleKey === 'PAY_MASTER' && x.seq === 1) throw err(409, 'SLOT_REQUIRED', 'O Pay Master 01 é obrigatório.'); if (x.userId) throw err(409, 'SLOT_FILLED', 'Cadeira ocupada: crie nova versão para trocar o participante.'); if (d.lines.some((l) => l.roleKey === x.roleKey && l.roleSeq === x.seq)) throw err(409, 'SLOT_HAS_LINES', 'Remova ou redirecione as linhas de comissão dessa função antes.'); if (d.invitations.some((i) => i.participantId === x.id)) throw err(409, 'SLOT_HAS_INVITES', 'Essa cadeira tem histórico de convites; mantenha-a ou crie nova versão.'); d.participants = d.participants.filter((q) => q.id !== x.id); save(); return ok({ ok: true }); });
  on('POST', '/api/deals/:id/slots/:pid/vacate', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'DRAFT') throw err(409, 'VERSION_LOCKED', 'Parceria travada: troca de carteira/participante só em nova versão.'); const x = d.participants.find((q) => q.id === p.pid); if (!x) throw err(404, 'NOT_FOUND', 'Cadeira não encontrada.'); if (x.roleKey === 'PAY_MASTER' && x.seq === 1) throw err(409, 'SLOT_REQUIRED', 'O Pay Master 01 (admin) não pode ser removido.'); x.userId = null; audit(d, 'ALLOCATION_CHANGED', s.uid, { entity: 'partnership_participant' }); save(); return ok({ ok: true }); });
  on('POST', '/api/deals/:id/submit', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); submit(d, s.uid); save(); return ok({ status: d.version.status, termsHash: d.version.termsHash }); });
  on('POST', '/api/deals/:id/reopen', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'PENDING_SIGNATURES') throw err(409, 'INVALID_TRANSITION', 'Só versões aguardando aceite podem voltar para DRAFT. Parcerias travadas exigem nova versão.'); const n = validSigs(d).length; d.signatures = d.signatures.map((x) => ({ ...x, termsHash: 'invalidated' })); d.version.status = 'DRAFT'; d.version.termsHash = null; audit(d, 'SIGNATURES_INVALIDATED', s.uid, { entity: 'partnership_version' }); audit(d, 'VERSION_REOPENED', s.uid, { entity: 'partnership_version' }); save(); return ok({ status: 'DRAFT', invalidated: n }); });
  on('POST', '/api/deals/:id/new-version', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'LOCKED') throw err(409, 'INVALID_TRANSITION', d.version.status === 'DRAFT' ? 'A versão atual já está em DRAFT.' : 'Nova versão só a partir de parceria LOCKED (antes do financiamento).'); d.version = { id: uuid(), no: d.version.no + 1, status: 'DRAFT', residualPolicy: d.version.residualPolicy, termsHash: null, lockedAt: null, versionsCount: d.version.versionsCount + 1 }; d.participants = d.participants.map((x) => ({ ...x, id: uuid() })); audit(d, 'VERSION_CREATED', s.uid, { entity: 'partnership_version', newValue: { version_no: d.version.no } }); save(); return ok({ versionId: d.version.id, versionNo: d.version.no }); });
  on('POST', '/api/deals/:id/agreement/challenge', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); if (d.version.status !== 'PENDING_SIGNATURES') throw err(409, 'NOT_PENDING', 'A parceria não está aguardando aceites.'); const part = d.participants.find((x) => x.userId === s.uid); if (!part) throw err(403, 'FORBIDDEN', 'Você não é participante desta versão.'); return ok(challenge('AGREEMENT', s.addr, { 'Operação': d.code, 'Versão': String(d.version.no), 'Hash dos termos': d.version.termsHash, 'Função': roleLabel(part.roleKey, part.seq), 'Participante': part.id })); });
  on('POST', '/api/deals/:id/agreement/sign', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); const ch = consume(b, 'AGREEMENT'); if (d.version.status !== 'PENDING_SIGNATURES' || ch.context['Hash dos termos'] !== d.version.termsHash) throw err(409, 'TERMS_CHANGED', 'Os termos mudaram desde o desafio. Revise e assine novamente.'); const part = d.participants.find((x) => x.userId === s.uid); if (!part || part.id !== ch.context['Participante'] || ch.address !== s.addr) throw err(403, 'FORBIDDEN', 'Assinatura de carteira que não ocupa esta função.'); if (validSigs(d).some((x) => x.participantId === part.id)) throw err(409, 'ALREADY_SIGNED', 'Você já assinou esta versão.'); recordSignature(d, part, userById(s.uid), ch.message, b.signature); save(); const k = validSigs(d).length; return ok({ k, n: d.participants.length, locked: d.version.status === 'LOCKED', status: d.version.status }); });
  on('GET', '/api/deals/:id/settlement/preview', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); const pv = previewSettlement(d); delete pv.dist; return ok(pv); });
  on('POST', '/api/deals/:id/settlement/challenge', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'LOCKED') throw err(409, 'NOT_LOCKED', 'A liquidação exige parceria LOCKED.'); const pv = previewSettlement(d); return ok(challenge('SETTLEMENT', s.addr, { 'Operação': d.code, 'Versão': String(d.version.no), 'Hash dos termos': d.version.termsHash, 'Modo': 'SIMULADO (DEMO) — nenhum fundo real é movimentado', 'Distribuição': `${pv.poolLabel} em ${pv.lines.length} linhas, conforme bps travados` })); });
  on('POST', '/api/deals/:id/settlement/fund', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); const ch = consume(b, 'SETTLEMENT'); if (d.version.status !== 'LOCKED' || ch.context['Hash dos termos'] !== d.version.termsHash) throw err(409, 'NOT_LOCKED', 'A liquidação exige parceria LOCKED com os mesmos termos.'); const pv = previewSettlement(d); const a = asset(d.reference.assetId); d.settlement = { id: uuid(), status: 'FUNDED', assetId: a.id, referenceAmount: d.reference.amount, poolAmount: pv.dist.pool.toString(), residualUnits: pv.dist.residualUnits.toString(), truncatedNumerator: pv.dist.truncatedNumerator, lines: pv.dist.lines.map((l) => ({ lineKey: l.lineKey, label: l.label, roleKey: l.roleKey, roleSeq: l.roleSeq, bps: l.bps, kind: l.kind, amount: l.amount.toString() })), createdAt: nowIso(), settledAt: null }; d.version.status = 'FUNDED'; audit(d, 'SETTLEMENT_CREATED', s.uid, { entity: 'settlement', wallet: s.addr }); audit(d, 'SETTLEMENT_FUNDED', s.uid, { entity: 'partnership_version' }); save(); return ok({ settlementId: d.settlement.id, status: 'FUNDED' }); });
  on('POST', '/api/deals/:id/settlement/execute', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); if (d.version.status !== 'FUNDED') throw err(409, 'NOT_FUNDED', 'A execução exige settlement FUNDED.'); d.version.status = 'EXECUTING'; d.settlement.status = 'EXECUTING'; audit(d, 'SETTLEMENT_EXECUTING', s.uid, { entity: 'settlement' }); d.version.status = 'SETTLED'; d.settlement.status = 'SETTLED'; d.settlement.settledAt = nowIso(); audit(d, 'SETTLEMENT_SETTLED', s.uid, { entity: 'settlement' }); save(); return ok(settlementView(d)); });
  on('GET', '/api/deals/:id/documents', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); return ok(documentsOut(d, s.uid)); });
  on('POST', '/api/deals/:id/documents', (b, p) => { const s = session(); const d = dealById(p.id); needAdmin(d, s.uid); const bytes = atob(b.contentBase64 || ''); if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw err(400, 'DOC_SIZE', 'Documento vazio ou acima de 2 MB.'); let docId = b.documentId, name = String(b.name || '').trim(); if (docId) { const prev = d.documents.find((x) => x.documentId === docId); if (!prev) throw err(404, 'NOT_FOUND', 'Documento não encontrado.'); name = prev.name; d.documents.filter((x) => x.documentId === docId).forEach((x) => { x.isLatest = false; }); } else { if (!name) throw err(400, 'DOC_NAME', 'Nome do documento inválido.'); docId = uuid(); } const n = d.documents.filter((x) => x.documentId === docId).length + 1; const hash = hex(nacl.hash(Uint8Array.from(bytes, (c) => c.charCodeAt(0)))).slice(0, 64); d.documents.push({ id: uuid(), documentId: docId, name, versionNo: n, hash, mime: b.mime, size: bytes.length, content: b.contentBase64, requiresAcceptance: b.requiresAcceptance ?? true, isLatest: true, acceptedBy: [], createdAt: nowIso() }); audit(d, 'DOCUMENT_ADDED', s.uid, { entity: 'document_version' }); save(); return ok({ documentId: docId, versionId: d.documents.slice(-1)[0].id, versionNo: n, sha256: hash }); });
  on('POST', '/api/deals/:id/documents/:vid/challenge', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); const x = d.documents.find((q) => q.id === p.vid); if (!x) throw err(404, 'NOT_FOUND', 'Documento não encontrado.'); return ok(challenge('DOCUMENT', s.addr, { Documento: x.documentId, 'Versão do documento': String(x.versionNo), 'SHA-256': x.hash, Registro: x.id })); });
  on('POST', '/api/deals/:id/documents/:vid/accept', (b, p) => { const s = session(); const d = dealById(p.id); needMember(d, s.uid); const ch = consume(b, 'DOCUMENT'); const x = d.documents.find((q) => q.id === p.vid); if (!x || ch.context.Registro !== x.id) throw err(409, 'DOC_CHANGED', 'O documento não corresponde ao desafio.'); if (x.acceptedBy.includes(s.uid)) throw err(409, 'ALREADY_ACCEPTED', 'Documento já aceito.'); x.acceptedBy.push(s.uid); audit(d, 'DOCUMENT_ACCEPTED', s.uid, { entity: 'document_version', wallet: s.addr }); save(); return ok({ ok: true }); });
  // convites — admin
  on('POST', '/invitations', (b) => { const s = session(); return ok(createInvite(dealById(b.dealId), s.uid, b.roleKey, b.roleSeq || 1, b.ttlHours)); });
  on('GET', '/invitations', (b, p, q) => { const s = session(); sweep(); const out = []; for (const d of S.deals) { if (d.adminUserId !== s.uid || (q.dealId && d.id !== q.dealId)) continue; for (const i of d.invitations) out.push({ id: i.id, status: i.status, statusLabel: i.status, role: roleLabel(i.roleKey, i.roleSeq), roleKey: i.roleKey, roleSeq: i.roleSeq, bps: i.bps, bpsLabel: fmtBps(i.bps), createdAt: i.createdAt, openedAt: i.openedAt, completedAt: i.completedAt, expiresAt: i.expiresAt, replacedById: i.replacedById, dealId: d.id, dealCode: d.code, title: d.title, versionNo: d.version.no, canRevoke: ['ATIVO', 'ABERTO'].includes(i.status), canRegenerate: i.status !== 'CONCLUIDO' && !i.replacedById }); } out.sort((a, b2) => (a.createdAt < b2.createdAt ? 1 : -1)); return ok({ invitations: out }); });
  const invAdmin = (id, uid) => { for (const d of S.deals) { const i = d.invitations.find((x) => x.id === id); if (i) { needAdmin(d, uid); return { d, i }; } } throw err(404, 'NOT_FOUND', 'Convite não encontrado.'); };
  on('POST', '/invitations/:id/revoke', (b, p) => { const s = session(); const { d, i } = invAdmin(p.id, s.uid); if (!['ATIVO', 'ABERTO'].includes(i.status)) throw err(409, 'INVITE_NOT_REVOCABLE', `Convite ${i.status} não pode ser revogado.`); i.status = 'REVOGADO'; audit(d, 'INVITE_REVOKED', s.uid, { entity: 'invitation' }); save(); return ok({ id: i.id, status: 'REVOGADO' }); });
  on('POST', '/invitations/:id/regenerate', (b, p) => { const s = session(); const { d, i } = invAdmin(p.id, s.uid); if (i.status === 'CONCLUIDO') throw err(409, 'INVITE_COMPLETED', 'Convite já concluído: o parceiro entra pela Verum Wallet.'); if (i.replacedById) throw err(409, 'INVITE_ALREADY_REPLACED', 'Esse convite já foi substituído.'); if (['ATIVO', 'ABERTO'].includes(i.status)) { i.status = 'REVOGADO'; audit(d, 'INVITE_REVOKED', s.uid, { entity: 'invitation' }); } const out = createInvite(d, s.uid, i.roleKey, i.roleSeq, b.ttlHours); i.replacedById = out.invitation.id; audit(d, 'INVITE_REGENERATED', s.uid, { entity: 'invitation' }); save(); return ok(out); });
  // convites — parceiro
  on('POST', '/invite/open', (b) => ok(openInv(b.token)));
  on('POST', '/invite/resume', (b) => { const { d, i } = requireOpen(b.token); if (Date.now() - new Date(i.openedAt).getTime() > 10 * 60e3) throw err(404, 'INVITE_INVALID', GENERIC); return ok({ step: stepOf(i), walletDownloadUrl: null, summary: i.codeVerified ? summary(d, i) : null, walletAddress: i.pendingAddress }); });
  on('POST', '/invite/verify-code', (b) => { const { d, i } = requireOpen(b.token); const code = normCode(b.code); if (!code || sha('pepper:' + code) !== i.codeHash) { i.failed += 1; audit(d, 'INVITE_CODE_FAILED', null, { entity: 'invitation' }); if (i.failed >= 5) { i.status = 'BLOQUEADO'; audit(d, 'INVITE_BLOCKED', null, { entity: 'invitation' }); save(); throw err(404, 'INVITE_INVALID', GENERIC); } save(); throw err(400, 'CODE_INVALID', `Código inválido. Tentativas restantes: ${5 - i.failed}.`, { remaining: 5 - i.failed }); } if (!i.codeVerified) { i.codeVerified = true; audit(d, 'INVITE_CODE_VERIFIED', null, { entity: 'invitation' }); } save(); return ok({ step: 'WALLET', summary: summary(d, i) }); });
  on('POST', '/invite/wallet-challenge', (b) => { const { d, i } = requireOpen(b.token); if (!i.codeVerified) throw err(400, 'CODE_REQUIRED', 'Informe o código do convite primeiro.'); return ok(challenge('INVITE', b.address, { Convite: i.id, 'Operação': d.code, Data: nowIso().slice(0, 10) })); });
  on('POST', '/invite/wallet-verify', (b) => { const { d, i } = requireOpen(b.token); const ch = consume(b, 'INVITE'); if (ch.context.Convite !== i.id) throw err(401, 'SIGNATURE_INVALID', 'Assinatura inválida.'); const u = userByAddr(ch.address); if (u && d.participants.some((x) => x.userId === u.id)) throw err(409, 'WALLET_ALREADY_IN_VERSION', 'Esta carteira já ocupa outra função nesta versão da parceria.'); i.pendingAddress = ch.address; i.walletVerified = true; i.userId = u?.id || null; audit(d, 'WALLET_CHALLENGE_SIGNED', u?.id, { entity: 'invitation', wallet: ch.address }); audit(d, 'WALLET_CONNECTED', u?.id, { entity: 'invitation', wallet: ch.address }); save(); return ok({ existingUser: !!u, step: u ? 'TERMS' : 'SIGNUP', walletAddress: ch.address, walletShort: `${ch.address.slice(0, 4)}...${ch.address.slice(-4)}` }); });
  on('POST', '/invite/signup', (b) => { const errs = validateSignup(b); if (errs.length) throw err(400, 'VALIDATION', errs.join(' ')); const { d, i } = requireOpen(b.token); if (!i.walletVerified) throw err(400, 'WALLET_REQUIRED', 'Conecte a Verum Wallet primeiro.'); if (i.userId) throw err(409, 'ALREADY_REGISTERED', 'Carteira já cadastrada: siga para o aceite dos termos.'); if (S.users.some((u) => u.email.toLowerCase() === b.email.trim().toLowerCase())) throw err(409, 'EMAIL_IN_USE', 'Este e-mail já está vinculado a outra carteira.'); const u = { id: uuid(), key: null, name: b.fullName.trim().replace(/\s+/g, ' '), email: b.email.trim().toLowerCase(), phone: b.phone.trim(), country: b.country, address: i.pendingAddress, createdAt: nowIso(), deletionRequestedAt: null }; S.users.push(u); i.userId = u.id; audit(d, 'SIGNUP_COMPLETED', u.id, { entity: 'user', wallet: u.address }); save(); return ok({ step: 'TERMS' }); });
  on('POST', '/invite/complete', (b) => { const { d, i } = requireOpen(b.token); if (!i.userId) throw err(400, 'SIGNUP_REQUIRED', 'Conclua o cadastro primeiro.'); const slot = d.participants.find((x) => x.id === i.participantId); if (!slot || slot.userId) throw err(409, 'SLOT_FILLED', 'Essa função já foi ocupada.'); if (d.version.status !== 'DRAFT') throw err(409, 'VERSION_LOCKED', 'A parceria saiu de DRAFT. Peça um convite na nova versão.'); slot.userId = i.userId; if (!d.members.includes(i.userId)) d.members.push(i.userId); i.status = 'CONCLUIDO'; i.completedAt = nowIso(); delete S.inviteSessions[i.id]; const u = userById(i.userId); S.session = { uid: u.id, addr: u.address }; audit(d, 'INVITE_COMPLETED', u.id, { entity: 'invitation', wallet: u.address }); save(); return ok({ dealId: d.id }); });

  // ------------------------------------------------------------------ fetch simulado
  S = load(); if (!S) seed();
  window.__votcPreviewReset = () => { localStorage.removeItem(KEY); seed(); location.hash = '#/home'; location.reload(); };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase(); const [path, qs] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    let body = {}; try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
    for (const r of routes) {
      if (r.method !== method) continue; const m = path.match(r.re); if (!m) continue;
      try { const out = r.fn(body, m.groups || {}, query); return new Response(JSON.stringify(out.data), { status: out.status, headers: { 'content-type': 'application/json' } }); }
      catch (e) { if (e.status) return new Response(JSON.stringify(e.payload), { status: e.status, headers: { 'content-type': 'application/json' } }); return new Response(JSON.stringify({ error: 'INTERNAL', message: e.message }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }
    return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `Rota não simulada: ${method} ${path}` }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
})();
