// Núcleo compartilhado: dados em tempo real (SSE), cálculos de apuração e utilidades de interface.
export const D = { cargos: [], candidatos: [], locais: [], secoes: [], boletins: [], config: {} };
const listeners = new Set();
let timer;

export async function carregar() {
  const r = await fetch('/api/data', { cache: 'no-store' });
  Object.assign(D, await r.json());
  idx();
  listeners.forEach(f => f());
}
export function aoMudar(f) { listeners.add(f); }

const I = { secao: new Map(), local: new Map(), bol: new Map(), cand: new Map() };
function idx() {
  I.secao = new Map(D.secoes.map(s => [s.id, s]));
  I.local = new Map(D.locais.map(l => [l.id, l]));
  I.cand = new Map(D.candidatos.map(c => [c.id, c]));
  I.bol = new Map(D.boletins.map(b => [`${b.secao_id}|${b.cargo_id}`, b]));
}
export const secaoPorId = id => I.secao.get(id);
export const localPorId = id => I.local.get(id);
export const boletim = (secaoId, cargoId) => I.bol.get(`${secaoId}|${cargoId}`);
export const candidatosDe = cargoId => D.candidatos.filter(c => c.cargo_id === cargoId);

export function iniciar() {
  const el = document.getElementById('live');
  const set = ok => { if (el) el.innerHTML = `<i class="dot ${ok ? '' : 'off'}"></i>${ok ? 'ao vivo' : 'reconectando…'} · ${new Date().toLocaleTimeString('pt-BR')}`; };
  const es = new EventSource('/api/stream');
  es.addEventListener('update', () => { clearTimeout(timer); timer = setTimeout(async () => { await carregar(); set(true); }, 150); });
  es.onopen = () => { carregar().then(() => set(true)); };
  es.onerror = () => set(false);
  return carregar().then(() => set(true));
}

// status: 'apurada' | 'rascunho' | 'aguardando'
export function statusSecao(secaoId, cargoId) { return boletim(secaoId, cargoId)?.status || 'aguardando'; }
export const ROTULO = { apurada: 'Apurada', rascunho: 'Em lançamento', aguardando: 'Aguardando' };
export const CLASSE = { apurada: 's-ok', rascunho: 's-part', aguardando: 's-wait' };
export const COR_STATUS = { apurada: '#1f8a4c', rascunho: '#e8a23a', aguardando: '#6c7b76' };

// só boletins "apurada" entram nos totais
export function resultado(cargoId) {
  const cands = candidatosDe(cargoId);
  const bols = D.boletins.filter(b => b.cargo_id === cargoId && b.status === 'apurada');
  const rank = cands.map(c => ({ ...c, votos: bols.reduce((a, b) => a + (b.votos[c.id] || 0), 0) }));
  const legenda = bols.reduce((a, b) => a + (b.legenda || 0), 0);
  const brancos = bols.reduce((a, b) => a + b.brancos, 0), nulos = bols.reduce((a, b) => a + b.nulos, 0);
  const comp = bols.reduce((a, b) => a + b.comparecimento, 0);
  const validos = rank.reduce((a, c) => a + c.votos, 0) + legenda;
  rank.sort((a, b) => b.votos - a.votos || a.nome.localeCompare(b.nome, 'pt-BR'));
  const favoritos = rank.filter(c => c.favorito);
  const exibidos = favoritos.length ? favoritos : rank.slice(0, 10);
  const modo = favoritos.length ? 'favoritos' : 'top10';
  const aptosTotal = D.secoes.reduce((a, s) => a + s.aptos, 0);
  const aptosApuradas = bols.reduce((a, b) => a + (secaoPorId(b.secao_id)?.aptos || 0), 0);
  return {
    rank, exibidos, modo, legenda, brancos, nulos, comp, validos, aptosTotal, aptosApuradas,
    secoesTotal: D.secoes.length, apuradas: bols.length,
    rascunho: D.boletins.filter(b => b.cargo_id === cargoId && b.status === 'rascunho').length,
  };
}

export function statusLocal(localId, cargoId) {
  const ss = D.secoes.filter(s => s.local_id === localId);
  const st = ss.map(s => statusSecao(s.id, cargoId));
  const ap = st.filter(x => x === 'apurada').length;
  const status = ap === ss.length && ss.length ? 'apurada' : (ap || st.includes('rascunho')) ? 'rascunho' : 'aguardando';
  return { status, total: ss.length, apuradas: ap };
}

export const fmt = n => (n ?? 0).toLocaleString('pt-BR');
export const pct = (v, t, d = 1) => (t ? (v / t * 100).toFixed(d).replace('.', ',') : '0,0') + '%';
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function cargoAtual() {
  const q = new URLSearchParams(location.search).get('cargo');
  let c = q || localStorage.getItem('cargo');
  if (!D.cargos.some(x => x.id === c)) c = D.cargos[0]?.id;
  return c;
}
export function seletorCargo(el, aoTrocar) {
  const atual = cargoAtual();
  el.innerHTML = D.cargos.map(c => `<option value="${c.id}" ${c.id === atual ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
  el.onchange = () => {
    try { localStorage.setItem('cargo', el.value); } catch {}
    const u = new URL(location.href); if (u.searchParams.has('cargo')) { u.searchParams.set('cargo', el.value); history.replaceState(null, '', u); }
    aoTrocar(el.value);
  };
}

export function menu(ativo) {
  const itens = [['/', 'Dashboard'], ['/lancar', 'Lançar boletim'], ['/candidatos', 'Candidatos'], ['/secoes', 'Seções'], ['/telao', 'Telão'], ['/admin', 'Cadastro']];
  document.querySelector('.topbar').insertAdjacentHTML('afterbegin',
    `<a class="brand" href="/">Apuração ${esc(D.config.municipio || 'Aracati')}<small>ELEIÇÕES 2026</small></a><nav class="nav">${itens.map(([h, t]) => `<a href="${h}" class="${h === ativo ? 'on' : ''}">${t}</a>`).join('')}</nav>`);
}

// ---------- escrita (PIN + nome) ----------
export function credenciais() {
  let pin = localStorage.getItem('pin'), user = localStorage.getItem('user');
  return { pin, user };
}
export function pedirLogin() {
  return new Promise(ok => {
    const c = credenciais();
    if (c.pin && c.user) return ok(c);
    const w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:4000;padding:16px';
    w.innerHTML = `<form class="dialog"><h2>Entrar para lançar</h2><p class="muted">Informe seu nome (fica no histórico) e o PIN combinado com a coordenação.</p>
      <input class="num" style="text-align:left" id="lg-user" placeholder="Seu nome" autocomplete="name" required>
      <input class="num" style="text-align:left" id="lg-pin" placeholder="PIN" type="password" inputmode="numeric" autocomplete="off" required>
      <div id="lg-err" class="no" style="color:var(--bad)"></div><button class="btn pri">Entrar</button></form>`;
    document.body.append(w);
    w.querySelector('#lg-user').focus();
    w.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const user = w.querySelector('#lg-user').value.trim(), pin = w.querySelector('#lg-pin').value.trim();
      const r = await fetch('/api/auth', { method: 'POST', headers: { 'x-pin': pin, 'x-user': encodeURIComponent(user) }, body: '{}' });
      if (!r.ok) { w.querySelector('#lg-err').textContent = 'PIN incorreto.'; return; }
      localStorage.setItem('pin', pin); localStorage.setItem('user', user); w.remove(); ok({ pin, user });
    };
  });
}
export async function enviar(metodo, rota, corpo) {
  const { pin, user } = credenciais();
  const r = await fetch(rota, { method: metodo, headers: { 'x-pin': pin || '', 'x-user': encodeURIComponent(user || ''), 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { localStorage.removeItem('pin'); await pedirLogin(); return enviar(metodo, rota, corpo); }
  if (!r.ok) throw new Error(j.erro || 'Erro ao salvar.');
  return j;
}
export function toast(msg, erro = false) {
  const t = document.createElement('div'); t.className = 'toast' + (erro ? ' err' : ''); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), erro ? 5000 : 2200);
}

export function rankingHtml(res) {
  return res.exibidos.map(c => `<div class="cand"><span class="n">${esc(c.numero)}</span><span class="name">${esc(c.nome)}${c.partido ? ` <span class="muted" style="font-weight:400">${esc(c.partido)}</span>` : ''}</span><span class="v">${fmt(c.votos)}</span></div>`).join('')
    || '<div class="empty">Nenhum candidato cadastrado para este cargo. Use a aba Cadastro.</div>';
}

// ---------- mapa (Leaflet) ----------
export function criarMapa(el, escuro = false) {
  if (!window.L) { el.innerHTML = '<div class="empty">Mapa indisponível sem internet.</div>'; return null; }
  if (escuro) el.classList.add('escuro');
  const m = L.map(el, { zoomControl: !escuro, attributionControl: !escuro }).setView([-4.5617, -37.7697], 12);
  const url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; // o telão escurece via CSS (ver .escuro)
  L.tileLayer(url, { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
  m._camada = L.layerGroup().addTo(m);
  return m;
}
export function desenharLocais(m, cargoId, aoClicar) {
  if (!m) return;
  m._camada.clearLayers();
  const pts = [];
  for (const l of D.locais) {
    if (l.lat == null || l.lng == null) continue;
    const st = statusLocal(l.id, cargoId);
    if (st.status === 'aguardando') continue; // só aparecem locais com votos já lançados
    const r = 12 + Math.min(st.total, 8) * 1.6;
    const mk = L.circleMarker([l.lat, l.lng], { radius: r, color: '#fff', weight: 2, fillColor: COR_STATUS[st.status], fillOpacity: .95 }).addTo(m._camada);
    mk.bindTooltip(String(st.total), { permanent: true, direction: 'center', className: 'pino' });
    mk.bindPopup(`<b>${esc(l.nome)}</b><br>${st.apuradas}/${st.total} seções apuradas`);
    if (aoClicar) mk.on('click', () => aoClicar(l));
    pts.push([l.lat, l.lng]);
  }
  if (m._aviso) { m._aviso.remove(); m._aviso = null; }
  if (!pts.length) {
    m._aviso = L.control({ position: 'topright' });
    m._aviso.onAdd = () => { const d = L.DomUtil.create('div'); d.textContent = 'Nenhum local com votos lançados neste cargo ainda.'; d.style.cssText = 'background:rgba(20,32,29,.85);color:#fff;padding:6px 10px;border-radius:6px;font:12px sans-serif'; return d; };
    m._aviso.addTo(m);
  }
  if (pts.length && !m._ajustado) { m.fitBounds(pts, { padding: [30, 30], maxZoom: 14 }); m._ajustado = true; }
}
