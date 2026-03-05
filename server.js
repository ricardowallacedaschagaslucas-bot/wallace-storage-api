/**
 * Wallace Storage API
 * Gerencia upload, autenticação e acesso a vídeos no Cloudflare R2
 */

const express = require('express');
const multer  = require('multer');
const jwt     = require('jsonwebtoken');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Cloudflare R2 Client ──
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId    : process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || 'wallace-videos';
const JWT_SECRET = process.env.JWT_SECRET || 'wallace-storage-secret-2026';

// ── Upload multer (memória) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// ══════════════════════════════════════════════
// BANCO DE DADOS SIMPLES (JSON em memória + persistência via env)
// Em produção, trocar por banco real
// ══════════════════════════════════════════════

// Clientes cadastrados — formato:
// { id, nome, login, senha, plano, diasRetencao, ativo, criadoEm }
let clientes = JSON.parse(process.env.CLIENTES_JSON || '[]');

// Eventos — formato:
// { id, clienteId, nome, senha, criadoEm }
let eventos = JSON.parse(process.env.EVENTOS_JSON || '[]');

function salvarDados() {
  // Em Railway, variáveis de ambiente não podem ser salvas via código
  // Usar este endpoint para exportar e reimportar
  console.log('[Wallace Storage] Dados atualizados em memória');
}

// ══════════════════════════════════════════════
// AUTENTICAÇÃO ADMIN
// ══════════════════════════════════════════════

const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin@fundacaowallace.org';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'wallace@admin2026';

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

function authCliente(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tipo !== 'cliente') return res.status(403).json({ erro: 'Acesso negado' });
    req.cliente = payload;
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

// ══════════════════════════════════════════════
// ROTAS PÚBLICAS
// ══════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ service: 'Wallace Storage API', status: 'online', version: '1.0.0' });
});

// Login Admin
app.post('/admin/login', (req, res) => {
  const { login, senha } = req.body;
  if (login !== ADMIN_LOGIN || senha !== ADMIN_SENHA) {
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  }
  const token = jwt.sign({ tipo: 'admin', login }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// Login Cliente
app.post('/cliente/login', (req, res) => {
  const { login, senha } = req.body;
  const cliente = clientes.find(c => c.login === login && c.senha === senha && c.ativo);
  if (!cliente) return res.status(401).json({ erro: 'Credenciais inválidas' });
  const token = jwt.sign({ tipo: 'cliente', clienteId: cliente.id, nome: cliente.nome }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, cliente: { id: cliente.id, nome: cliente.nome, plano: cliente.plano } });
});

// Upload de vídeo por candidato (usa senha do evento)
app.post('/upload/:eventoId', upload.array('videos', 2), async (req, res) => {
  const { eventoId } = req.params;
  const { senha, nomeCandidato } = req.body;

  const evento = eventos.find(e => e.id === eventoId && e.senha === senha);
  if (!evento) return res.status(401).json({ erro: 'Senha do evento inválida' });

  const cliente = clientes.find(c => c.id === evento.clienteId);
  if (!cliente || !cliente.ativo) return res.status(403).json({ erro: 'Cliente inativo' });

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  }

  const agora    = new Date();
  const dataStr  = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const nomeSlug = (nomeCandidato || 'candidato').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  const uploads  = [];

  for (const file of req.files) {
    const tipo    = file.originalname.includes('CAMERA') ? 'CAMERA' : 'TELA';
    const key     = `${cliente.id}/${eventoId}/${nomeSlug}_${dataStr}_${tipo}.webm`;

    await r2.send(new PutObjectCommand({
      Bucket     : BUCKET,
      Key        : key,
      Body       : file.buffer,
      ContentType: 'video/webm',
      Metadata   : {
        candidato : nomeCandidato || '',
        evento    : evento.nome,
        cliente   : cliente.nome,
        uploadedAt: agora.toISOString(),
      },
    }));

    uploads.push({ key, tipo, tamanho: file.size });
  }

  console.log(`[Upload] ${nomeCandidato} → ${eventoId} → ${uploads.length} arquivo(s)`);
  res.json({ sucesso: true, uploads });
});

// ══════════════════════════════════════════════
// ROTAS DO CLIENTE
// ══════════════════════════════════════════════

// Listar eventos do cliente
app.get('/cliente/eventos', authCliente, (req, res) => {
  const meus = eventos.filter(e => e.clienteId === req.cliente.clienteId);
  res.json(meus);
});

// Listar vídeos de um evento
app.get('/cliente/eventos/:eventoId/videos', authCliente, async (req, res) => {
  const evento = eventos.find(e => e.id === req.params.eventoId && e.clienteId === req.cliente.clienteId);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });

  const prefix = `${req.cliente.clienteId}/${req.params.eventoId}/`;
  const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));

  const videos = await Promise.all((result.Contents || []).map(async obj => {
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }), { expiresIn: 3600 });
    const partes = obj.Key.split('/').pop().split('_');
    return {
      key      : obj.Key,
      nome     : obj.Key.split('/').pop(),
      tamanho  : obj.Size,
      modificado: obj.LastModified,
      url,
    };
  }));

  res.json({ evento, videos });
});

// ══════════════════════════════════════════════
// ROTAS ADMIN
// ══════════════════════════════════════════════

// Listar clientes
app.get('/admin/clientes', authAdmin, (req, res) => {
  res.json(clientes.map(c => ({ ...c, senha: '***' })));
});

// Criar cliente
app.post('/admin/clientes', authAdmin, (req, res) => {
  const { nome, login, senha, plano, diasRetencao } = req.body;
  if (!nome || !login || !senha || !plano) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, login, senha, plano' });
  }
  if (clientes.find(c => c.login === login)) {
    return res.status(409).json({ erro: 'Login já existe' });
  }
  const cliente = {
    id          : crypto.randomUUID(),
    nome, login, senha, plano,
    diasRetencao: diasRetencao || 90,
    ativo       : true,
    criadoEm   : new Date().toISOString(),
  };
  clientes.push(cliente);
  salvarDados();
  res.json({ sucesso: true, cliente: { ...cliente, senha: '***' } });
});

// Atualizar cliente
app.put('/admin/clientes/:id', authAdmin, (req, res) => {
  const idx = clientes.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Cliente não encontrado' });
  clientes[idx] = { ...clientes[idx], ...req.body, id: clientes[idx].id };
  salvarDados();
  res.json({ sucesso: true });
});

// Listar eventos (admin)
app.get('/admin/eventos', authAdmin, (req, res) => {
  res.json(eventos);
});

// Criar evento
app.post('/admin/eventos', authAdmin, (req, res) => {
  const { clienteId, nome, senha } = req.body;
  if (!clienteId || !nome || !senha) {
    return res.status(400).json({ erro: 'Campos obrigatórios: clienteId, nome, senha' });
  }
  const evento = {
    id      : crypto.randomUUID(),
    clienteId, nome, senha,
    criadoEm: new Date().toISOString(),
  };
  eventos.push(evento);
  salvarDados();
  res.json({ sucesso: true, evento });
});

// Exportar dados (para backup)
app.get('/admin/exportar', authAdmin, (req, res) => {
  res.json({ clientes, eventos });
});

// Importar dados
app.post('/admin/importar', authAdmin, (req, res) => {
  if (req.body.clientes) clientes = req.body.clientes;
  if (req.body.eventos)  eventos  = req.body.eventos;
  res.json({ sucesso: true, clientes: clientes.length, eventos: eventos.length });
});

// Storage stats por cliente
app.get('/admin/clientes/:id/stats', authAdmin, async (req, res) => {
  const cliente = clientes.find(c => c.id === req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado' });

  const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${req.params.id}/` }));
  const totalBytes = (result.Contents || []).reduce((acc, obj) => acc + obj.Size, 0);
  const totalGB    = (totalBytes / (1024 ** 3)).toFixed(2);

  res.json({ clienteId: req.params.id, totalArquivos: (result.Contents || []).length, totalGB });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`[Wallace Storage API] Rodando na porta ${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
