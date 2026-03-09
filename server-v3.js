/**
 * Wallace Storage API v3
 * Persistência via SQLite + Volume Railway
 */

const express  = require('express');
const multer   = require('multer');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path     = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cors     = require('cors');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── SQLite — usa /data se existir (Volume Railway), senão /tmp ──
const DB_DIR  = require('fs').existsSync('/data') ? '/data' : '/tmp';
const DB_PATH = path.join(DB_DIR, 'wallace.db');
console.log(`[DB] Usando: ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    login TEXT UNIQUE NOT NULL,
    senha TEXT NOT NULL,
    plano TEXT NOT NULL,
    diasRetencao INTEGER DEFAULT 90,
    ativo INTEGER DEFAULT 1,
    criadoEm TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS eventos (
    id TEXT PRIMARY KEY,
    clienteId TEXT NOT NULL,
    nome TEXT NOT NULL,
    senha TEXT NOT NULL,
    criadoEm TEXT NOT NULL
  );
`);

// ── Cloudflare R2 ──
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId    : process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET      = process.env.R2_BUCKET    || 'wallace-videos';
const JWT_SECRET  = process.env.JWT_SECRET   || 'wallace-storage-secret-2026';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN  || 'contato@fundacaowallace.org';
const ADMIN_SENHA = process.env.ADMIN_SENHA  || 'wallace@admin2026';

// ── Upload ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ── Auth ──
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.tipo !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
    req.admin = p; next();
  } catch { res.status(401).json({ erro: 'Token inválido' }); }
}

function authCliente(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.tipo !== 'cliente') return res.status(403).json({ erro: 'Acesso negado' });
    req.cliente = p; next();
  } catch { res.status(401).json({ erro: 'Token inválido' }); }
}

// ══ ROTAS ══

app.get('/', (_, res) => res.json({ service: 'Wallace Storage API', status: 'online', version: '3.0.0' }));

// Login admin
app.post('/admin/login', (req, res) => {
  const { login, senha } = req.body;
  if (login !== ADMIN_LOGIN || senha !== ADMIN_SENHA)
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'admin', login }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// Login cliente
app.post('/cliente/login', (req, res) => {
  const c = db.prepare('SELECT * FROM clientes WHERE login=? AND senha=? AND ativo=1').get(req.body.login, req.body.senha);
  if (!c) return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'cliente', clienteId: c.id, nome: c.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, cliente: { id: c.id, nome: c.nome, plano: c.plano } });
});

// Upload vídeo
app.post('/upload/:eventoId', upload.array('videos', 2), async (req, res) => {
  const evento  = db.prepare('SELECT * FROM eventos WHERE id=? AND senha=?').get(req.params.eventoId, req.body.senha);
  if (!evento) return res.status(401).json({ erro: 'Senha do evento inválida' });
  const cliente = db.prepare('SELECT * FROM clientes WHERE id=? AND ativo=1').get(evento.clienteId);
  if (!cliente)  return res.status(403).json({ erro: 'Cliente inativo' });
  if (!req.files?.length) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });

  const agora    = new Date();
  const dataStr  = agora.toISOString().replace(/[:.]/g,'-').slice(0,19);
  const nomeSlug = (req.body.nomeCandidato||'candidato').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
  const uploads  = [];

  for (const file of req.files) {
    const tipo = file.originalname.toUpperCase().includes('CAMERA') ? 'CAMERA' : 'TELA';
    const key  = `${cliente.id}/${evento.id}/${nomeSlug}_${dataStr}_${tipo}.webm`;
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: file.buffer, ContentType: 'video/webm',
      Metadata: { candidato: req.body.nomeCandidato||'', evento: evento.nome, cliente: cliente.nome, uploadedAt: agora.toISOString() },
    }));
    uploads.push({ key, tipo, tamanho: file.size });
  }
  console.log(`[Upload] ${req.body.nomeCandidato} → ${req.params.eventoId} → ${uploads.length} arquivo(s)`);
  res.json({ sucesso: true, uploads });
});

// Eventos do cliente
app.get('/cliente/eventos', authCliente, (req, res) => {
  res.json(db.prepare('SELECT * FROM eventos WHERE clienteId=?').all(req.cliente.clienteId));
});

// Vídeos de um evento
app.get('/cliente/eventos/:eventoId/videos', authCliente, async (req, res) => {
  const evento = db.prepare('SELECT * FROM eventos WHERE id=? AND clienteId=?').get(req.params.eventoId, req.cliente.clienteId);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });
  const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${req.cliente.clienteId}/${req.params.eventoId}/` }));
  const videos = await Promise.all((result.Contents||[]).map(async obj => {
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }), { expiresIn: 3600 });
    return { key: obj.Key, nome: obj.Key.split('/').pop(), tamanho: obj.Size, modificado: obj.LastModified, url };
  }));
  res.json({ evento, videos });
});

// Admin — clientes
app.get('/admin/clientes', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,nome,login,plano,diasRetencao,ativo,criadoEm FROM clientes').all());
});

app.post('/admin/clientes', authAdmin, (req, res) => {
  const { nome, login, senha, plano, diasRetencao } = req.body;
  if (!nome||!login||!senha||!plano) return res.status(400).json({ erro: 'Campos obrigatórios: nome, login, senha, plano' });
  try {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO clientes VALUES (?,?,?,?,?,?,1,?)').run(id, nome, login, senha, plano, diasRetencao||90, new Date().toISOString());
    res.json({ sucesso: true, cliente: { id, nome, login, plano } });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ erro: 'Login já existe' });
    throw e;
  }
});

app.put('/admin/clientes/:id', authAdmin, (req, res) => {
  const { nome, plano, diasRetencao, ativo, senha } = req.body;
  db.prepare('UPDATE clientes SET nome=COALESCE(?,nome), plano=COALESCE(?,plano), diasRetencao=COALESCE(?,diasRetencao), ativo=COALESCE(?,ativo), senha=COALESCE(?,senha) WHERE id=?')
    .run(nome||null, plano||null, diasRetencao||null, ativo!=null?ativo:null, senha||null, req.params.id);
  res.json({ sucesso: true });
});

// Admin — eventos
app.get('/admin/eventos', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM eventos').all());
});

app.post('/admin/eventos', authAdmin, (req, res) => {
  const { clienteId, nome, senha } = req.body;
  if (!clienteId||!nome||!senha) return res.status(400).json({ erro: 'Campos obrigatórios: clienteId, nome, senha' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO eventos VALUES (?,?,?,?,?)').run(id, clienteId, nome, senha, new Date().toISOString());
  res.json({ sucesso: true, evento: { id, clienteId, nome, senha } });
});

app.delete('/admin/eventos/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM eventos WHERE id=?').run(req.params.id);
  res.json({ sucesso: true });
});

// Exportar/importar backup
app.get('/admin/exportar', authAdmin, (req, res) => {
  res.json({
    clientes: db.prepare('SELECT * FROM clientes').all(),
    eventos : db.prepare('SELECT * FROM eventos').all(),
  });
});

app.post('/admin/importar', authAdmin, (req, res) => {
  const insertC = db.prepare('INSERT OR REPLACE INTO clientes VALUES (?,?,?,?,?,?,?,?)');
  const insertE = db.prepare('INSERT OR REPLACE INTO eventos VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (const c of (req.body.clientes||[])) insertC.run(c.id,c.nome,c.login,c.senha,c.plano,c.diasRetencao,c.ativo,c.criadoEm);
    for (const e of (req.body.eventos||[]))  insertE.run(e.id,e.clienteId,e.nome,e.senha,e.criadoEm);
  })();
  res.json({ sucesso: true });
});

app.listen(PORT, () => console.log(`[Wallace Storage API v3 — SQLite] Porta ${PORT} | DB: ${DB_PATH}`));
process.on('SIGTERM', () => { db.close(); process.exit(0); });
