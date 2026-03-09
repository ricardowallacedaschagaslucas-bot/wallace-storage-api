/**
 * Wallace Storage API v2
 * Persistência via arquivo JSON no volume Railway
 */

const express = require('express');
const multer  = require('multer');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Cloudflare R2 ──
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId    : process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET     = process.env.R2_BUCKET || 'wallace-videos';
const JWT_SECRET = process.env.JWT_SECRET || 'wallace-storage-secret-2026';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'contato@fundacaowallace.org';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'wallace@admin2026';

// ── Persistência via arquivo JSON ──
const DB_FILE = path.join('/tmp', 'wallace-db.json');

function carregarDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch(e) { console.error('Erro ao carregar DB:', e); }
  return { clientes: [], eventos: [] };
}

function salvarDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } 
  catch(e) { console.error('Erro ao salvar DB:', e); }
}

let db = carregarDB();

// ── Upload multer ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ── Auth middlewares ──
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
    req.admin = payload;
    next();
  } catch { res.status(401).json({ erro: 'Token inválido ou expirado' }); }
}

function authCliente(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'cliente') return res.status(403).json({ erro: 'Acesso negado' });
    req.cliente = payload;
    next();
  } catch { res.status(401).json({ erro: 'Token inválido ou expirado' }); }
}

// ── Rotas públicas ──
app.get('/', (req, res) => {
  res.json({ service: 'Wallace Storage API', status: 'online', version: '2.0.0' });
});

app.post('/admin/login', (req, res) => {
  const { login, senha } = req.body;
  if (login !== ADMIN_LOGIN || senha !== ADMIN_SENHA)
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'admin', login }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.post('/cliente/login', (req, res) => {
  db = carregarDB();
  const cliente = db.clientes.find(c => c.login === req.body.login && c.senha === req.body.senha && c.ativo);
  if (!cliente) return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'cliente', clienteId: cliente.id, nome: cliente.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, cliente: { id: cliente.id, nome: cliente.nome, plano: cliente.plano } });
});

// ── Upload de vídeo ──
app.post('/upload/:eventoId', upload.array('videos', 2), async (req, res) => {
  db = carregarDB();
  const { eventoId } = req.params;
  const { senha, nomeCandidato } = req.body;
  const evento = db.eventos.find(e => e.id === eventoId && e.senha === senha);
  if (!evento) return res.status(401).json({ erro: 'Senha do evento inválida' });
  const cliente = db.clientes.find(c => c.id === evento.clienteId);
  if (!cliente || !cliente.ativo) return res.status(403).json({ erro: 'Cliente inativo' });
  if (!req.files || !req.files.length) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });

  const agora   = new Date();
  const dataStr = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const nomeSlug = (nomeCandidato || 'candidato').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  const uploads = [];

  for (const file of req.files) {
    const tipo = file.originalname.toUpperCase().includes('CAMERA') ? 'CAMERA' : 'TELA';
    const key  = `${cliente.id}/${eventoId}/${nomeSlug}_${dataStr}_${tipo}.webm`;
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: file.buffer, ContentType: 'video/webm',
      Metadata: { candidato: nomeCandidato || '', evento: evento.nome, cliente: cliente.nome, uploadedAt: agora.toISOString() },
    }));
    uploads.push({ key, tipo, tamanho: file.size });
  }
  console.log(`[Upload] ${nomeCandidato} → ${eventoId} → ${uploads.length} arquivo(s)`);
  res.json({ sucesso: true, uploads });
});

// ── Rotas cliente ──
app.get('/cliente/eventos', authCliente, (req, res) => {
  db = carregarDB();
  res.json(db.eventos.filter(e => e.clienteId === req.cliente.clienteId));
});

app.get('/cliente/eventos/:eventoId/videos', authCliente, async (req, res) => {
  db = carregarDB();
  const evento = db.eventos.find(e => e.id === req.params.eventoId && e.clienteId === req.cliente.clienteId);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });
  const prefix = `${req.cliente.clienteId}/${req.params.eventoId}/`;
  const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  const videos = await Promise.all((result.Contents || []).map(async obj => {
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }), { expiresIn: 3600 });
    return { key: obj.Key, nome: obj.Key.split('/').pop(), tamanho: obj.Size, modificado: obj.LastModified, url };
  }));
  res.json({ evento, videos });
});

// ── Rotas admin ──
app.get('/admin/clientes', authAdmin, (req, res) => {
  db = carregarDB();
  res.json(db.clientes.map(c => ({ ...c, senha: '***' })));
});

app.post('/admin/clientes', authAdmin, (req, res) => {
  db = carregarDB();
  const { nome, login, senha, plano, diasRetencao } = req.body;
  if (!nome || !login || !senha || !plano) return res.status(400).json({ erro: 'Campos obrigatórios: nome, login, senha, plano' });
  if (db.clientes.find(c => c.login === login)) return res.status(409).json({ erro: 'Login já existe' });
  const cliente = { id: crypto.randomUUID(), nome, login, senha, plano, diasRetencao: diasRetencao || 90, ativo: true, criadoEm: new Date().toISOString() };
  db.clientes.push(cliente);
  salvarDB(db);
  res.json({ sucesso: true, cliente: { ...cliente, senha: '***' } });
});

app.put('/admin/clientes/:id', authAdmin, (req, res) => {
  db = carregarDB();
  const idx = db.clientes.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Cliente não encontrado' });
  db.clientes[idx] = { ...db.clientes[idx], ...req.body, id: db.clientes[idx].id };
  salvarDB(db);
  res.json({ sucesso: true });
});

app.get('/admin/eventos', authAdmin, (req, res) => {
  db = carregarDB();
  res.json(db.eventos);
});

app.post('/admin/eventos', authAdmin, (req, res) => {
  db = carregarDB();
  const { clienteId, nome, senha } = req.body;
  if (!clienteId || !nome || !senha) return res.status(400).json({ erro: 'Campos obrigatórios: clienteId, nome, senha' });
  const evento = { id: crypto.randomUUID(), clienteId, nome, senha, criadoEm: new Date().toISOString() };
  db.eventos.push(evento);
  salvarDB(db);
  res.json({ sucesso: true, evento });
});

app.get('/admin/exportar', authAdmin, (req, res) => {
  db = carregarDB();
  res.json(db);
});

app.post('/admin/importar', authAdmin, (req, res) => {
  if (req.body.clientes) db.clientes = req.body.clientes;
  if (req.body.eventos)  db.eventos  = req.body.eventos;
  salvarDB(db);
  res.json({ sucesso: true, clientes: db.clientes.length, eventos: db.eventos.length });
});

app.listen(PORT, () => console.log(`[Wallace Storage API v2] Porta ${PORT}`));
process.on('SIGTERM', () => process.exit(0));
