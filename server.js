// Servidor da apuração: HTTP + SQLite (node:sqlite) + SSE para tempo real. Sem dependências.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buscarCandidatos, buscarSecoes } from './tse.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const PIN = String(process.env.VOTOS_PIN || '1234');
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(ROOT, 'data', 'votos.db'));

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS cargos(id TEXT PRIMARY KEY, nome TEXT, vagas INTEGER DEFAULT 1, legenda INTEGER DEFAULT 0, ordem INTEGER);
CREATE TABLE IF NOT EXISTS candidatos(id INTEGER PRIMARY KEY AUTOINCREMENT, cargo_id TEXT, numero TEXT, nome TEXT, partido TEXT, cor TEXT, UNIQUE(cargo_id,numero));
CREATE TABLE IF NOT EXISTS locais(id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT UNIQUE, endereco TEXT, lat REAL, lng REAL);
CREATE TABLE IF NOT EXISTS secoes(id INTEGER PRIMARY KEY AUTOINCREMENT, zona INTEGER, numero INTEGER, local_id INTEGER, aptos INTEGER DEFAULT 0, UNIQUE(zona,numero));
CREATE TABLE IF NOT EXISTS boletins(secao_id INTEGER, cargo_id TEXT, status TEXT, comparecimento INTEGER, brancos INTEGER, nulos INTEGER, legenda INTEGER DEFAULT 0, usuario TEXT, updated_at TEXT, PRIMARY KEY(secao_id,cargo_id));
CREATE TABLE IF NOT EXISTS votos(secao_id INTEGER, cargo_id TEXT, candidato_id INTEGER, votos INTEGER, PRIMARY KEY(secao_id,cargo_id,candidato_id));
CREATE TABLE IF NOT EXISTS historico(id INTEGER PRIMARY KEY AUTOINCREMENT, secao_id INTEGER, cargo_id TEXT, usuario TEXT, em TEXT, acao TEXT, dados TEXT);
`);

for (const alt of ['ALTER TABLE candidatos ADD COLUMN vice TEXT DEFAULT \'\'', 'ALTER TABLE secoes ADD COLUMN agregadas TEXT DEFAULT \'\'', 'ALTER TABLE candidatos ADD COLUMN favorito INTEGER DEFAULT 0', 'ALTER TABLE locais ADD COLUMN token TEXT']) { try { db.exec(alt); } catch {} }

const CORES = ['#0b6e5a', '#d4572a', '#3d5fc4', '#9a7b1c', '#8a4fa0', '#c2306b', '#2f8f9d', '#6b7a1f'];
const CARGOS = [
  ['presidente', 'Presidente', 1, 0], ['governador', 'Governador', 1, 0], ['senador', 'Senador', 2, 0],
  ['dep_federal', 'Deputado Federal', 1, 1], ['dep_estadual', 'Deputado Estadual', 1, 1],
];

function seedDemo() {
  const has = db.prepare('SELECT COUNT(*) n FROM cargos').get().n;
  if (has) return;
  CARGOS.forEach((c, i) => db.prepare('INSERT INTO cargos VALUES(?,?,?,?,?)').run(...c, i));
  db.prepare("INSERT OR REPLACE INTO config VALUES('municipio','Aracati')").run();
  db.prepare("INSERT OR REPLACE INTO config VALUES('demo','1')").run();
  const nomes = ['A', 'B', 'C', 'D'];
  const nums = { presidente: [13, 22, 15, 30], governador: [13, 45, 22, 30], senador: [131, 456, 222, 301], dep_federal: [1301, 4502, 2203, 3004], dep_estadual: [13011, 45022, 22033, 30044] };
  for (const [id] of CARGOS) nomes.forEach((n, i) => db.prepare('INSERT INTO candidatos(cargo_id,numero,nome,partido,cor) VALUES(?,?,?,?,?)').run(id, String(nums[id][i]), `Candidato Exemplo ${n}`, 'EXEMPLO', CORES[i]));
  const centro = [-4.5617, -37.7697];
  const locais = ['E.E.F.M. Cel. Alexandrino', 'Escola Municipal Centro', 'Ginásio Poliesportivo', 'E.E.M. Padre Cícero', 'Escola Canoa Quebrada', 'Escola Cumbe', 'Escola Mundaú', 'Escola Majorlândia'];
  locais.forEach((nome, i) => {
    const a = (i / locais.length) * Math.PI * 2, r = i === 0 ? 0 : 0.02 + (i % 3) * 0.015;
    const lat = centro[0] + Math.sin(a) * r, lng = centro[1] + Math.cos(a) * r;
    const lid = db.prepare('INSERT INTO locais(nome,endereco,lat,lng) VALUES(?,?,?,?)').run(nome, '(exemplo)', lat, lng).lastInsertRowid;
    for (let s = 0; s < 4 + (i % 3); s++) db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos) VALUES(?,?,?,?)').run(18, i * 10 + s + 1, lid, 280 + ((i * 17 + s * 29) % 40));
  });
}
seedDemo();

// ---------- dados ----------
function snapshot() {
  const cfg = Object.fromEntries(db.prepare('SELECT k,v FROM config').all().map(r => [r.k, r.v]));
  const votos = db.prepare('SELECT * FROM votos').all();
  const vmap = {};
  for (const v of votos) (vmap[`${v.secao_id}|${v.cargo_id}`] ||= {})[v.candidato_id] = v.votos;
  const boletins = db.prepare('SELECT * FROM boletins').all().map(b => ({ ...b, votos: vmap[`${b.secao_id}|${b.cargo_id}`] || {} }));
  return {
    config: cfg,
    cargos: db.prepare('SELECT * FROM cargos ORDER BY ordem').all(),
    candidatos: db.prepare('SELECT * FROM candidatos ORDER BY cargo_id, id').all(),
    locais: db.prepare('SELECT id,nome,endereco,lat,lng FROM locais ORDER BY nome').all(),
    secoes: db.prepare('SELECT * FROM secoes ORDER BY zona, numero').all(),
    boletins,
    ts: Date.now(),
  };
}

const int = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN; };

function salvarBoletim(b, usuario) {
  const secao = db.prepare('SELECT * FROM secoes WHERE id=?').get(b.secao_id);
  const cargo = db.prepare('SELECT * FROM cargos WHERE id=?').get(b.cargo_id);
  if (!secao || !cargo) throw new Error('Seção ou cargo inexistente.');
  const status = b.status === 'rascunho' ? 'rascunho' : 'apurada';
  // parcial: só atualiza o que veio no pedido e mantém o resto do boletim (usado ao lançar só os favoritos).
  const existente = b.parcial ? db.prepare('SELECT * FROM boletins WHERE secao_id=? AND cargo_id=?').get(secao.id, cargo.id) : null;
  const votosAntes = {};
  if (existente) for (const v of db.prepare('SELECT candidato_id, votos FROM votos WHERE secao_id=? AND cargo_id=?').all(secao.id, cargo.id)) votosAntes[v.candidato_id] = v.votos;
  const br = int(b.brancos ?? existente?.brancos ?? 0), nu = int(b.nulos ?? existente?.nulos ?? 0), leg = cargo.legenda ? int(b.legenda ?? existente?.legenda ?? 0) : 0;
  if ([br, nu, leg].some(Number.isNaN)) throw new Error('Há campos com valor inválido.');
  const cands = db.prepare('SELECT id FROM candidatos WHERE cargo_id=?').all(cargo.id);
  let soma = br + nu + leg;
  const linhas = [];
  for (const c of cands) { const v = int(b.votos?.[c.id] ?? votosAntes[c.id] ?? 0); if (Number.isNaN(v)) throw new Error('Há votos inválidos.'); soma += v; linhas.push([c.id, v]); }
  // O comparecimento é calculado a partir dos votos lançados (senador: cada eleitor vota em 2).
  const comp = Math.ceil(soma / cargo.vagas);
  if (status === 'apurada') {
    if (soma === 0) throw new Error('Lance ao menos um voto antes de salvar.');
    if (secao.aptos > 0 && comp > secao.aptos) throw new Error(`Os votos somam ${soma}, mais do que os ${secao.aptos} eleitores aptos desta seção${cargo.vagas > 1 ? ` (x${cargo.vagas})` : ''}. Confira a digitação.`);
  }
  const agora = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR REPLACE INTO boletins VALUES(?,?,?,?,?,?,?,?,?)').run(secao.id, cargo.id, status, comp, br, nu, leg, usuario, agora);
    db.prepare('DELETE FROM votos WHERE secao_id=? AND cargo_id=?').run(secao.id, cargo.id);
    for (const [cid, v] of linhas) db.prepare('INSERT INTO votos VALUES(?,?,?,?)').run(secao.id, cargo.id, cid, v);
    db.prepare('INSERT INTO historico(secao_id,cargo_id,usuario,em,acao,dados) VALUES(?,?,?,?,?,?)').run(secao.id, cargo.id, usuario, agora, status, JSON.stringify(b));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function excluirBoletim(secao_id, cargo_id, usuario) {
  db.prepare('DELETE FROM boletins WHERE secao_id=? AND cargo_id=?').run(secao_id, cargo_id);
  db.prepare('DELETE FROM votos WHERE secao_id=? AND cargo_id=?').run(secao_id, cargo_id);
  db.prepare('INSERT INTO historico(secao_id,cargo_id,usuario,em,acao,dados) VALUES(?,?,?,?,?,?)').run(secao_id, cargo_id, usuario, new Date().toISOString(), 'excluido', '{}');
}

// ---------- importação CSV ----------
function parseCsv(txt) {
  txt = txt.replace(/^﻿/, '').trim();
  const first = txt.split(/\r?\n/)[0];
  const sep = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  const rows = txt.split(/\r?\n/).filter(Boolean).map(l => l.split(sep).map(x => x.trim().replace(/^"|"$/g, '')));
  const head = rows.shift().map(h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function importar(tipo, csv) {
  const rows = parseCsv(csv);
  let n = 0;
  db.exec('BEGIN');
  try {
    if (tipo === 'secoes') {
      for (const r of rows) {
        const zona = int(r.zona), numero = int(r.secao ?? r.numero), aptos = int(r.aptos || 0);
        const nome = r.local || r['local de votacao'];
        if (Number.isNaN(zona) || Number.isNaN(numero) || !nome) throw new Error(`Linha inválida: ${JSON.stringify(r)}`);
        const lat = r.lat ? Number(String(r.lat).replace(',', '.')) : null, lng = r.lng ? Number(String(r.lng).replace(',', '.')) : null;
        db.prepare('INSERT INTO locais(nome,endereco,lat,lng) VALUES(?,?,?,?) ON CONFLICT(nome) DO UPDATE SET endereco=COALESCE(NULLIF(excluded.endereco,\'\'),endereco), lat=COALESCE(excluded.lat,lat), lng=COALESCE(excluded.lng,lng)').run(nome, r.endereco || '', lat, lng);
        const lid = db.prepare('SELECT id FROM locais WHERE nome=?').get(nome).id;
        db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos) VALUES(?,?,?,?) ON CONFLICT(zona,numero) DO UPDATE SET local_id=excluded.local_id, aptos=excluded.aptos').run(zona, numero, lid, Number.isNaN(aptos) ? 0 : aptos);
        n++;
      }
    } else if (tipo === 'candidatos') {
      for (const r of rows) {
        const cargo = db.prepare('SELECT id FROM cargos WHERE id=? OR lower(nome)=lower(?)').get(r.cargo, r.cargo);
        if (!cargo || !r.numero || !r.nome) throw new Error(`Linha inválida (cargo/numero/nome): ${JSON.stringify(r)}`);
        const ja = db.prepare('SELECT cor FROM candidatos WHERE cargo_id=? AND numero=?').get(cargo.id, r.numero);
        const qtd = db.prepare('SELECT COUNT(*) n FROM candidatos WHERE cargo_id=?').get(cargo.id).n;
        db.prepare('INSERT INTO candidatos(cargo_id,numero,nome,partido,cor) VALUES(?,?,?,?,?) ON CONFLICT(cargo_id,numero) DO UPDATE SET nome=excluded.nome, partido=excluded.partido').run(cargo.id, r.numero, r.nome, r.partido || '', ja?.cor || CORES[qtd % CORES.length]);
        n++;
      }
    } else throw new Error('Tipo de importação desconhecido.');
    db.prepare("INSERT OR REPLACE INTO config VALUES('demo','0')").run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

function zerar(escopo) {
  db.exec('BEGIN');
  db.exec('DELETE FROM votos; DELETE FROM boletins; DELETE FROM historico;');
  if (escopo === 'tudo') db.exec('DELETE FROM candidatos; DELETE FROM secoes; DELETE FROM locais;');
  if (escopo === 'tudo') db.prepare("INSERT OR REPLACE INTO config VALUES('demo','0')").run();
  db.exec('COMMIT');
}


// ---------- importação direta do TSE ----------
let importando = false;
async function importarTse({ uf = 'CE', municipio = 'Aracati' }) {
  if (importando) throw new Error('Já existe uma importação em andamento.');
  importando = true;
  try {
    const pasta = path.join(ROOT, 'data', 'tse');
    const [c, s] = await Promise.all([buscarCandidatos(uf, pasta), buscarSecoes(uf, municipio, pasta)]);
    if (!c.candidatos.length) throw new Error('O TSE não devolveu candidatos.');
    const demo = db.prepare("SELECT v FROM config WHERE k='demo'").get()?.v === '1';
    db.exec('BEGIN');
    try {
      if (demo) db.exec('DELETE FROM votos; DELETE FROM boletins; DELETE FROM historico; DELETE FROM candidatos; DELETE FROM secoes; DELETE FROM locais;');
      // candidatos: atualiza, inclui os novos e remove os que saíram da lista (se ainda sem votos)
      const porCargo = {};
      for (const k of c.candidatos) {
        (porCargo[k.cargo] ||= []).push(k);
        const ja = db.prepare('SELECT cor FROM candidatos WHERE cargo_id=? AND numero=?').get(k.cargo, k.numero);
        const qtd = db.prepare('SELECT COUNT(*) n FROM candidatos WHERE cargo_id=?').get(k.cargo).n;
        db.prepare('INSERT INTO candidatos(cargo_id,numero,nome,partido,cor,vice) VALUES(?,?,?,?,?,?) ON CONFLICT(cargo_id,numero) DO UPDATE SET nome=excluded.nome, partido=excluded.partido, vice=excluded.vice').run(k.cargo, k.numero, k.nome, k.partido, ja?.cor || CORES[qtd % CORES.length], k.vice);
      }
      let removidos = 0;
      for (const cargo of Object.keys(porCargo)) {
        const nums = new Set(porCargo[cargo].map(x => x.numero));
        for (const r of db.prepare('SELECT id,numero FROM candidatos WHERE cargo_id=?').all(cargo)) {
          if (nums.has(r.numero)) continue;
          if (db.prepare('SELECT 1 FROM votos WHERE candidato_id=? AND votos>0').get(r.id)) continue;
          db.prepare('DELETE FROM votos WHERE candidato_id=?').run(r.id);
          db.prepare('DELETE FROM candidatos WHERE id=?').run(r.id); removidos++;
        }
      }
      for (const x of s.secoes) {
        db.prepare('INSERT INTO locais(nome,endereco,lat,lng) VALUES(?,?,?,?) ON CONFLICT(nome) DO UPDATE SET endereco=excluded.endereco, lat=COALESCE(excluded.lat,lat), lng=COALESCE(excluded.lng,lng)').run(x.local, x.endereco, x.lat, x.lng);
        const lid = db.prepare('SELECT id FROM locais WHERE nome=?').get(x.local).id;
        db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos,agregadas) VALUES(?,?,?,?,?) ON CONFLICT(zona,numero) DO UPDATE SET local_id=excluded.local_id, aptos=excluded.aptos, agregadas=excluded.agregadas').run(x.zona, x.numero, lid, x.aptos, x.agregadas);
      }
      db.prepare("INSERT OR REPLACE INTO config VALUES('demo','0')").run();
      db.prepare("INSERT OR REPLACE INTO config VALUES('municipio',?)").run(s.nomeMunicipio.charAt(0) + s.nomeMunicipio.slice(1).toLowerCase());
      db.prepare("INSERT OR REPLACE INTO config VALUES('tse_importado_em',?)").run(new Date().toISOString());
      db.exec('COMMIT');
      const locais = new Set(s.secoes.map(x => x.local)).size;
      return { candidatos: c.candidatos.length, removidos, secoes: s.secoes.length, agregadas: s.totalAgregadas, locais, comCoordenadas: new Set(s.secoes.filter(x => x.lat != null).map(x => x.local)).size, avisos: c.avisos, limpouExemplo: demo };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { importando = false; }
}


// ---------- seções e locais (edição manual) ----------
const num = (x) => { const n = Number(String(x ?? '').replace(',', '.')); return String(x ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
function salvarSecao(b) {
  const zona = int(b.zona), numero = int(b.numero), aptos = int(b.aptos || 0), local = Number(b.local_id);
  if ([zona, numero, aptos].some(Number.isNaN) || !numero) throw new Error('Informe zona, número da seção e aptos com números válidos.');
  if (!db.prepare('SELECT 1 FROM locais WHERE id=?').get(local)) throw new Error('Escolha o local de votação.');
  const agregadas = String(b.agregadas || '').replace(/[^\d,]/g, '');
  try {
    if (b.id) db.prepare('UPDATE secoes SET zona=?, numero=?, local_id=?, aptos=?, agregadas=? WHERE id=?').run(zona, numero, local, aptos, agregadas, Number(b.id));
    else db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos,agregadas) VALUES(?,?,?,?,?)').run(zona, numero, local, aptos, agregadas);
  } catch (e) { if (/UNIQUE/i.test(e.message)) throw new Error(`Já existe a seção ${zona}/${numero}.`); throw e; }
}
function excluirSecao(id) {
  db.prepare('DELETE FROM votos WHERE secao_id=?').run(id);
  db.prepare('DELETE FROM boletins WHERE secao_id=?').run(id);
  db.prepare('DELETE FROM secoes WHERE id=?').run(id);
}
function salvarLocal(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw new Error('Informe o nome do local.');
  const lat = num(b.lat), lng = num(b.lng);
  if ((lat != null && (lat < -35 || lat > 6)) || (lng != null && (lng < -75 || lng > -30))) throw new Error('Coordenadas fora do Brasil. Confira latitude e longitude.');
  try {
    if (b.id) db.prepare('UPDATE locais SET nome=?, endereco=?, lat=?, lng=? WHERE id=?').run(nome, String(b.endereco || ''), lat, lng, Number(b.id));
    else return Number(db.prepare('INSERT INTO locais(nome,endereco,lat,lng) VALUES(?,?,?,?)').run(nome, String(b.endereco || ''), lat, lng).lastInsertRowid);
    return Number(b.id);
  } catch (e) { if (/UNIQUE/i.test(e.message)) throw new Error('Já existe um local com esse nome.'); throw e; }
}
function excluirLocal(id) {
  if (db.prepare('SELECT 1 FROM secoes WHERE local_id=?').get(id)) throw new Error('Este local ainda tem seções. Mova ou exclua as seções antes.');
  db.prepare('DELETE FROM locais WHERE id=?').run(id);
}


// ---------- chefe de local: link próprio, sem PIN ----------
const ipsDaRede = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
function baseUrl() {
  const c = db.prepare("SELECT v FROM config WHERE k='base_url'").get()?.v;
  return (c || `http://${ipsDaRede()[0] || 'localhost'}:${PORT}`).replace(/\/+$/, '');
}
function tokenDoLocal(localId, regenerar = false) {
  const l = db.prepare('SELECT token FROM locais WHERE id=?').get(localId);
  if (!l) throw new Error('Local inexistente.');
  if (l.token && !regenerar) return l.token;
  const t = crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE locais SET token=? WHERE id=?').run(t, localId);
  return t;
}
function localPorToken(t) {
  const l = t && String(t).length >= 8 ? db.prepare('SELECT id,nome,endereco FROM locais WHERE token=?').get(String(t)) : null;
  if (!l) throw new Error('Link inválido ou desativado. Peça um novo link à coordenação.');
  return l;
}
// o chefe lança só os candidatos favoritos de cada cargo
function gruposFavoritos() {
  return db.prepare('SELECT * FROM cargos ORDER BY ordem').all().map(c => ({
    cargo: { id: c.id, nome: c.nome, vagas: c.vagas },
    candidatos: db.prepare('SELECT id,numero,nome,partido,vice,cor FROM candidatos WHERE cargo_id=? AND favorito=1 ORDER BY nome').all(c.id),
  })).filter(g => g.candidatos.length);
}
function dadosChefe(t) {
  const local = localPorToken(t);
  const grupos = gruposFavoritos();
  const secoes = db.prepare('SELECT id,zona,numero,aptos,agregadas FROM secoes WHERE local_id=? ORDER BY zona,numero').all(local.id);
  const bols = [];
  for (const s of secoes) for (const g of grupos) {
    const b = db.prepare('SELECT status,updated_at FROM boletins WHERE secao_id=? AND cargo_id=?').get(s.id, g.cargo.id);
    if (!b) continue;
    const votos = {};
    for (const v of db.prepare('SELECT candidato_id,votos FROM votos WHERE secao_id=? AND cargo_id=?').all(s.id, g.cargo.id)) votos[v.candidato_id] = v.votos;
    bols.push({ secao_id: s.id, cargo_id: g.cargo.id, status: b.status, updated_at: b.updated_at, votos });
  }
  return { municipio: db.prepare("SELECT v FROM config WHERE k='municipio'").get()?.v || 'Aracati', local, secoes, grupos, boletins: bols };
}
function salvarChefe(t, b) {
  const local = localPorToken(t);
  const secao = db.prepare('SELECT id FROM secoes WHERE id=? AND local_id=?').get(Number(b.secao_id), local.id);
  if (!secao) throw new Error('Esta seção não pertence ao seu local.');
  const permitidos = new Set(db.prepare('SELECT id FROM candidatos WHERE cargo_id=? AND favorito=1').all(b.cargo_id).map(c => String(c.id)));
  const votos = {};
  for (const [k, v] of Object.entries(b.votos || {})) { if (!permitidos.has(String(k))) throw new Error('Candidato fora da lista.'); votos[k] = v; }
  if (!Object.keys(votos).length) throw new Error('Digite os votos antes de enviar.');
  const quem = String(b.nome || '').trim().slice(0, 40) || 'chefe';
  salvarBoletim({ secao_id: secao.id, cargo_id: b.cargo_id, status: 'apurada', parcial: true, votos }, `${quem} · ${local.nome}`.slice(0, 80));
}

// ---------- http ----------
const clients = new Set();
const broadcast = (evt = 'update') => { for (const r of clients) r.write(`event: ${evt}\ndata: ${Date.now()}\n\n`); };
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 20000);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.ico': 'image/x-icon' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); }); req.on('end', () => ok(d)); req.on('error', no); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/data') return json(res, 200, snapshot());
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname === '/api/chefe' && req.method === 'GET') return json(res, 200, dadosChefe(url.searchParams.get('t')));
    if (url.pathname === '/api/chefe/boletim' && req.method === 'POST') {
      salvarChefe(url.searchParams.get('t'), JSON.parse((await readBody(req)) || '{}'));
      broadcast(); return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      if (req.headers['x-pin'] !== PIN) return json(res, 401, { erro: 'PIN incorreto.' });
      const usuario = decodeURIComponent(req.headers['x-user'] || 'anônimo').slice(0, 40);
      const body = JSON.parse((await readBody(req)) || '{}');
      if (url.pathname === '/api/auth') return json(res, 200, { ok: true });
      if (url.pathname === '/api/admin/link') { const t = tokenDoLocal(Number(body.local_id), !!body.regenerar); return json(res, 200, { ok: true, url: `${baseUrl()}/chefe?t=${t}`, base: baseUrl() }); }
      if (url.pathname === '/api/admin/config') { const v = String(body.base_url || '').trim(); if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('Informe o endereço completo, começando com http:// ou https://'); db.prepare("INSERT OR REPLACE INTO config VALUES('base_url',?)").run(v); return json(res, 200, { ok: true, base: baseUrl() }); }
      if (url.pathname === '/api/boletim' && req.method === 'POST') { salvarBoletim(body, usuario); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/boletim' && req.method === 'DELETE') { excluirBoletim(body.secao_id, body.cargo_id, usuario); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/admin/importar') { const n = importar(body.tipo, body.csv); broadcast(); return json(res, 200, { ok: true, n }); }
      if (url.pathname === '/api/admin/importar-tse') { const r = await importarTse(body); broadcast(); return json(res, 200, { ok: true, ...r }); }
      if (url.pathname === '/api/secao' && req.method === 'POST') { salvarSecao(body); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/secao' && req.method === 'DELETE') { excluirSecao(Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/local' && req.method === 'POST') { const id = salvarLocal(body); broadcast(); return json(res, 200, { ok: true, id }); }
      if (url.pathname === '/api/local' && req.method === 'DELETE') { excluirLocal(Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/favorito') { db.prepare('UPDATE candidatos SET favorito=? WHERE id=?').run(body.favorito ? 1 : 0, Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/admin/zerar') { zerar(body.escopo); broadcast(); return json(res, 200, { ok: true }); }
      return json(res, 404, { erro: 'Rota não encontrada.' });
    }
    // estáticos
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!path.extname(p)) p += '.html';
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 400, { erro: e.message });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\nApuração Aracati 2026 rodando.\n  Neste computador: http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Na rede (celulares): http://${i.address}:${PORT}`);
  console.log(`  PIN de lançamento: ${PIN} ${process.env.VOTOS_PIN ? '' : '(padrão; defina VOTOS_PIN para trocar)'}\n`);
});
