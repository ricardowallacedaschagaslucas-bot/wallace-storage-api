/**
 * Wallace Storage API v3
 * Persistência via JSON em Volume Railway (/data)
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
app.use(express.json({ limit: '10mb' }));

// Aumentar timeout para uploads grandes
app.use((req, res, next) => {
  res.setTimeout(300000); // 5 minutos
  next();
});

// ── Persistência: /data (Volume Railway) ou /tmp ──
const DB_DIR  = fs.existsSync('/data') ? '/data' : '/tmp';
const DB_PATH = path.join(DB_DIR, 'wallace-db.json');
console.log(`[DB] Usando: ${DB_PATH}`);

function lerDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) { console.error('Erro ao ler DB:', e); }
  return { clientes: [], eventos: [] };
}

function salvarDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Erro ao salvar DB:', e); }
}

// ── Cloudflare R2 ──
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId    : process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET      = process.env.R2_BUCKET   || 'wallace-videos';
const JWT_SECRET  = process.env.JWT_SECRET  || 'wallace-storage-secret-2026';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'contato@fundacaowallace.org';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'wallace@admin2026';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

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

app.post('/admin/login', (req, res) => {
  const { login, senha } = req.body;
  if (login !== ADMIN_LOGIN || senha !== ADMIN_SENHA)
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'admin', login }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.post('/cliente/login', (req, res) => {
  const { clientes } = lerDB();
  const c = clientes.find(x => x.login === req.body.login && x.senha === req.body.senha && x.ativo);
  if (!c) return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'cliente', clienteId: c.id, nome: c.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, cliente: { id: c.id, nome: c.nome, plano: c.plano } });
});

app.post('/upload/:eventoId', upload.array('videos', 2), async (req, res) => {
  const { clientes, eventos } = lerDB();
  const evento  = eventos.find(e => e.id === req.params.eventoId && e.senha === req.body.senha);
  if (!evento) return res.status(401).json({ erro: 'Senha do evento inválida' });
  const cliente = clientes.find(c => c.id === evento.clienteId && c.ativo);
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
      Metadata: { candidato: req.body.nomeCandidato||'', evento: evento.nome, uploadedAt: agora.toISOString() },
    }));
    uploads.push({ key, tipo, tamanho: file.size });
  }
  console.log(`[Upload] ${req.body.nomeCandidato} → ${req.params.eventoId} → ${uploads.length} arquivo(s)`);
  res.json({ sucesso: true, uploads });
});


// Gerar URL assinada para upload direto ao R2
app.post('/upload-url/:eventoId', async (req, res) => {
  const { clientes, eventos } = lerDB();
  const { senha, nomeCandidato, sufixo } = req.body; // sufixo: TELA ou CAMERA
  const evento  = eventos.find(e => e.id === req.params.eventoId && e.senha === senha);
  if (!evento) return res.status(401).json({ erro: 'Senha do evento inválida' });
  const cliente = clientes.find(c => c.id === evento.clienteId && c.ativo);
  if (!cliente)  return res.status(403).json({ erro: 'Cliente inativo' });

  const agora    = new Date();
  const dataStr  = agora.toISOString().replace(/[:.]/g,'-').slice(0,19);
  const nomeSlug = (nomeCandidato||'candidato').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
  const key      = `${cliente.id}/${evento.id}/${nomeSlug}_${dataStr}_${sufixo}.webm`;

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl }     = require('@aws-sdk/s3-request-presigner');
  const url = await getSignedUrl(r2, new PutObjectCommand({
    Bucket: BUCKET, Key: key, ContentType: 'video/webm'
  }), { expiresIn: 3600 });

  res.json({ url, key });
});

app.get('/cliente/eventos', authCliente, (req, res) => {
  const { eventos } = lerDB();
  res.json(eventos.filter(e => e.clienteId === req.cliente.clienteId));
});

app.get('/cliente/eventos/:eventoId/videos', authCliente, async (req, res) => {
  const { eventos } = lerDB();
  const evento = eventos.find(e => e.id === req.params.eventoId && e.clienteId === req.cliente.clienteId);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });
  const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${req.cliente.clienteId}/${req.params.eventoId}/` }));
  const videos = await Promise.all((result.Contents||[]).map(async obj => {
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }), { expiresIn: 3600 });
    return { key: obj.Key, nome: obj.Key.split('/').pop(), tamanho: obj.Size, modificado: obj.LastModified, url };
  }));
  res.json({ evento, videos });
});

app.get('/admin/clientes', authAdmin, (req, res) => {
  const { clientes } = lerDB();
  res.json(clientes.map(c => ({ ...c, senha: '***' })));
});

app.post('/admin/clientes', authAdmin, (req, res) => {
  const db = lerDB();
  const { nome, login, senha, plano, diasRetencao } = req.body;
  if (!nome||!login||!senha||!plano) return res.status(400).json({ erro: 'Campos obrigatórios: nome, login, senha, plano' });
  if (db.clientes.find(c => c.login === login)) return res.status(409).json({ erro: 'Login já existe' });
  const cliente = { id: crypto.randomUUID(), nome, login, senha, plano, diasRetencao: diasRetencao||90, ativo: true, criadoEm: new Date().toISOString() };
  db.clientes.push(cliente);
  salvarDB(db);
  res.json({ sucesso: true, cliente: { ...cliente, senha: '***' } });
});

app.put('/admin/clientes/:id', authAdmin, (req, res) => {
  const db = lerDB();
  const idx = db.clientes.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Não encontrado' });
  db.clientes[idx] = { ...db.clientes[idx], ...req.body, id: db.clientes[idx].id };
  salvarDB(db);
  res.json({ sucesso: true });
});

app.get('/admin/eventos', authAdmin, (req, res) => {
  const { eventos } = lerDB();
  res.json(eventos);
});

app.post('/admin/eventos', authAdmin, (req, res) => {
  const db = lerDB();
  const { clienteId, nome, senha } = req.body;
  if (!clienteId||!nome||!senha) return res.status(400).json({ erro: 'Campos obrigatórios' });
  const evento = { id: crypto.randomUUID(), clienteId, nome, senha, criadoEm: new Date().toISOString() };
  db.eventos.push(evento);
  salvarDB(db);
  res.json({ sucesso: true, evento });
});

app.delete('/admin/eventos/:id', authAdmin, (req, res) => {
  const db = lerDB();
  db.eventos = db.eventos.filter(e => e.id !== req.params.id);
  salvarDB(db);
  res.json({ sucesso: true });
});

app.get('/admin/exportar', authAdmin, (_, res) => res.json(lerDB()));

app.post('/admin/importar', authAdmin, (req, res) => {
  const db = lerDB();
  if (req.body.clientes) db.clientes = req.body.clientes;
  if (req.body.eventos)  db.eventos  = req.body.eventos;
  salvarDB(db);
  res.json({ sucesso: true });
});

app.listen(PORT, () => console.log(`[Wallace Storage API v3] Porta ${PORT} | DB: ${DB_PATH}`));
process.on('SIGTERM', () => process.exit(0));
