// Busca candidatos e seções direto do TSE (Dados Abertos), no mesmo método do projeto eleicoessinalnews:
//  - consulta_cand_2026.zip  → candidatos, números, partidos e vices (um CSV por UF)
//  - DivulgaCandContas       → confere quem continua apto (o CSV traz também renúncias e substituídos)
//  - eleitorado_local_votacao_2026.zip → zona, seção, local de votação, endereço, coordenadas e eleitores
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_CAND = process.env.CAND_ZIP || 'https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_2026.zip';
const ZIP_LOCAIS = process.env.LOCAIS_ZIP || 'https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip';
const DIVULGA = process.env.CAND_ORIGEM || 'https://divulgacandcontas.tse.jus.br/divulga/rest';
const ELEICAO = process.env.CAND_ELEICAO || '20322002026'; // Eleição Geral Federal 2026
const ANO = '2026';
const MIN = 60 * 1000;

// cargo do sistema → código do TSE
const CARGOS = { presidente: 1, governador: 3, senador: 5, dep_federal: 6, dep_estadual: 7 };
const CARGO_VICE = { 1: '2', 3: '4' }; // presidente → vice-presidente, governador → vice-governador

// O TSE recusa requisições sem cara de navegador.
const CABECALHOS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: 'https://divulgacandcontas.tse.jus.br/divulga/',
};

export const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// Baixa um arquivo grande com cache em disco. Se o TSE falhar, usa a cópia antiga.
async function baixarZip(url, arquivo, validadeMs, pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  const destino = path.join(pasta, arquivo);
  let antigo = null;
  try {
    const info = fs.statSync(destino);
    if (info.size > 1000) {
      antigo = destino;
      if (Date.now() - info.mtimeMs < validadeMs) return fs.readFileSync(destino);
    }
  } catch {}
  try {
    const r = await fetch(url, { headers: CABECALHOS, signal: AbortSignal.timeout(10 * MIN) });
    if (!r.ok) throw new Error(`TSE respondeu ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(destino, buf);
    return buf;
  } catch (e) {
    if (antigo) return fs.readFileSync(antigo);
    throw new Error(`Não consegui baixar ${arquivo} do TSE: ${e.message}`);
  }
}

// Leitor mínimo de ZIP: devolve { nomeDoArquivo: () => Buffer }.
function lerZip(buf) {
  let fim = buf.length - 22;
  while (fim >= 0 && buf.readUInt32LE(fim) !== 0x06054b50) fim--;
  if (fim < 0) throw new Error('arquivo ZIP inválido');
  const arquivos = {};
  let p = buf.readUInt32LE(fim + 16);
  for (let k = buf.readUInt16LE(fim + 10); k > 0; k--) {
    const metodo = buf.readUInt16LE(p + 10);
    const tamanho = buf.readUInt32LE(p + 20);
    const [nNome, nExtra, nComent] = [buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32)];
    const posicao = buf.readUInt32LE(p + 42);
    arquivos[buf.toString('latin1', p + 46, p + 46 + nNome)] = () => {
      const inicio = posicao + 30 + buf.readUInt16LE(posicao + 26) + buf.readUInt16LE(posicao + 28);
      const dados = buf.subarray(inicio, inicio + tamanho);
      return metodo === 0 ? dados : zlib.inflateRawSync(dados);
    };
    p += 46 + nNome + nExtra + nComent;
  }
  return arquivos;
}

// CSV do TSE: latin1, separado por ";", textos entre aspas.
function lerCsv(buf) {
  const linhas = buf.toString('latin1').split(/\r?\n/).filter(Boolean);
  const partir = (l) => {
    const campos = [];
    let atual = '';
    let aspas = false;
    for (const ch of l) {
      if (ch === '"') aspas = !aspas;
      else if (ch === ';' && !aspas) { campos.push(atual); atual = ''; } else atual += ch;
    }
    campos.push(atual);
    return campos;
  };
  const colunas = partir(linhas[0]);
  return linhas.slice(1).map((l) => {
    const campos = partir(l);
    return Object.fromEntries(colunas.map((c, i) => [c, campos[i]]));
  });
}

const arquivoDaUf = (zip, prefixo, uf) => {
  const nome = Object.keys(zip).find((n) => n.toUpperCase().endsWith(`_${uf}.CSV`) && n.toLowerCase().includes(prefixo));
  if (!nome) throw new Error(`UF ${uf} não está no arquivo do TSE.`);
  return lerCsv(zip[nome]());
};

// Quando um número aparece mais de uma vez (substituição), fica o registro mais recente.
function maisRecentePorNumero(linhas) {
  const m = new Map();
  for (const l of linhas) {
    const a = m.get(l.NR_CANDIDATO);
    if (!a || BigInt(l.SQ_CANDIDATO) > BigInt(a.SQ_CANDIDATO)) m.set(l.NR_CANDIDATO, l);
  }
  return m;
}

// IDs dos candidatos aptos segundo o DivulgaCandContas (null se a consulta falhar).
async function aptosDivulga(uf, codigo) {
  try {
    const r = await fetch(`${DIVULGA}/v1/candidatura/listar/${ANO}/${uf}/${ELEICAO}/${codigo}/candidatos`, { headers: CABECALHOS, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const d = await r.json();
    const lista = (d.candidatos || []).filter((c) => c.candidatoApto !== false);
    return lista.length ? new Set(lista.map((c) => String(c.id))) : null;
  } catch { return null; }
}

const SITUACAO_FORA = /ren[uú]nc|indefer|cancel|fal[eê]c|inapt|n[aã]o conhecido/i;

export async function buscarCandidatos(uf, pasta, log = () => {}) {
  log('Baixando lista de candidatos do TSE…');
  const zip = lerZip(await baixarZip(ZIP_CAND, 'consulta_cand_2026.zip', 30 * MIN, pasta));
  const estadual = arquivoDaUf(zip, 'consulta_cand', uf).filter((l) => l.NR_TURNO === '1');
  let federal = [];
  try { federal = arquivoDaUf(zip, 'consulta_cand', 'BR').filter((l) => l.NR_TURNO === '1'); } catch {}
  const saida = [];
  const avisos = [];
  for (const [cargo, codigo] of Object.entries(CARGOS)) {
    const csv = cargo === 'presidente' ? federal : estadual;
    const doCargo = csv.filter((l) => l.CD_CARGO === String(codigo) && !SITUACAO_FORA.test(l.DS_SITUACAO_CANDIDATURA || ''));
    const aptos = await aptosDivulga(cargo === 'presidente' ? 'BR' : uf, codigo);
    if (!aptos) avisos.push(`Não consegui conferir aptidão de ${cargo} no DivulgaCandContas; usei o registro mais recente de cada número.`);
    const titulares = aptos ? doCargo.filter((l) => aptos.has(l.SQ_CANDIDATO)) : [...maisRecentePorNumero(doCargo).values()];
    const vices = maisRecentePorNumero(csv.filter((l) => l.CD_CARGO === CARGO_VICE[codigo]));
    for (const l of titulares) {
      saida.push({ cargo, numero: l.NR_CANDIDATO, nome: l.NM_URNA_CANDIDATO, partido: l.SG_PARTIDO, vice: vices.get(l.NR_CANDIDATO)?.NM_URNA_CANDIDATO || '' });
    }
  }
  return { candidatos: saida, avisos };
}

const coord = (v, min, max) => {
  const n = Number(String(v || '').replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max && n !== 0 ? n : null;
};

// Linhas do arquivo de locais de votação da UF (cache em memória: o CSV do estado inteiro é pesado de ler).
const cacheLocais = new Map();
async function linhasDaUf(uf, pasta, log = () => {}) {
  const c = cacheLocais.get(uf);
  if (c && Date.now() - c.t < 30 * MIN) return c.linhas;
  log('Baixando seções e locais de votação do TSE (arquivo grande, pode levar um minuto)…');
  const zip = lerZip(await baixarZip(ZIP_LOCAIS, 'eleitorado_local_votacao_2026.zip', 12 * 60 * MIN, pasta));
  const linhas = arquivoDaUf(zip, 'eleitorado', uf);
  cacheLocais.set(uf, { t: Date.now(), linhas });
  return linhas;
}

// Nomes dos municípios da UF, como o TSE escreve (é o que a importação procura).
export async function listarMunicipios(uf, pasta) {
  const nomes = new Set((await linhasDaUf(uf, pasta)).map((l) => l.NM_MUNICIPIO));
  return [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export async function buscarSecoes(uf, municipio, pasta, log = () => {}) {
  return secoesDoMunicipio(await linhasDaUf(uf, pasta, log), uf, municipio);
}

export function secoesDoMunicipio(todas, uf, municipio) {
  const alvo = semAcento(municipio);
  const linhas = todas.filter((l) => semAcento(l.NM_MUNICIPIO) === alvo);
  if (!linhas.length) throw new Error(`Município "${municipio}" não encontrado em ${uf} no arquivo do TSE.`);
  const principais = linhas.filter((l) => l.CD_TIPO_SECAO_AGREGADA === '1' || l.DS_TIPO_SECAO_AGREGADA === 'Principal');
  // Seção agregada vota na urna da principal: os eleitores somam e ela aparece junto no boletim.
  const agregadas = new Map();
  const ehPrincipal = new Set(principais);
  for (const l of linhas) {
    if (ehPrincipal.has(l)) continue;
    const chave = `${l.NR_ZONA}|${l.NR_SECAO_PRINCIPAL}`;
    if (!agregadas.has(chave)) agregadas.set(chave, []);
    agregadas.get(chave).push(l);
  }
  // Dois locais com o mesmo nome e números diferentes ganham o número no nome.
  const numerosPorNome = new Map();
  for (const l of principais) {
    if (!numerosPorNome.has(l.NM_LOCAL_VOTACAO)) numerosPorNome.set(l.NM_LOCAL_VOTACAO, new Set());
    numerosPorNome.get(l.NM_LOCAL_VOTACAO).add(l.NR_LOCAL_VOTACAO);
  }
  const secoes = principais.map((l) => {
    const extra = agregadas.get(`${l.NR_ZONA}|${l.NR_SECAO}`) || [];
    const endereco = [l.DS_ENDERECO, l.NM_BAIRRO].filter(Boolean).join(' · ');
    return {
      zona: Number(l.NR_ZONA),
      numero: Number(l.NR_SECAO),
      local: numerosPorNome.get(l.NM_LOCAL_VOTACAO).size > 1 ? `${l.NM_LOCAL_VOTACAO} (nº ${l.NR_LOCAL_VOTACAO})` : l.NM_LOCAL_VOTACAO,
      endereco,
      lat: coord(l.NR_LATITUDE, -35, 6),
      lng: coord(l.NR_LONGITUDE, -75, -30),
      aptos: Number(l.QT_ELEITOR_SECAO || 0) + extra.reduce((a, x) => a + Number(x.QT_ELEITOR_SECAO || 0), 0),
      agregadas: extra.map((x) => x.NR_SECAO).join(','),
    };
  });
  return { secoes, nomeMunicipio: linhas[0].NM_MUNICIPIO, totalAgregadas: linhas.length - principais.length };
}
