import crypto from 'crypto';

/**
 * API de Conversões da Meta — CERNE
 *
 * Recebe eventos do navegador e reenvia server-side para a Meta,
 * usando o mesmo event_id do pixel (deduplicação).
 *
 * Variáveis de ambiente necessárias na Vercel:
 *   META_PIXEL_ID          -> 1934407753926495
 *   META_CAPI_TOKEN        -> token gerado no Gerenciador de Eventos (SECRETO)
 *   META_TEST_EVENT_CODE   -> opcional, só durante os testes (ex: TEST12345)
 */

const API_VERSION = 'v21.0';

// Só estes eventos são aceitos — evita que alguém use sua rota para poluir o pixel
const EVENTOS_PERMITIDOS = new Set([
  'PageView',
  'ViewContent',
  'InitiateCheckout',
  'Lead',
  'Contact',
]);

// Domínios autorizados a chamar esta rota
const ORIGENS_PERMITIDAS = [
  'https://vistacomcerne.com.br',
  'https://www.vistacomcerne.com.br',
];

function sha256(valor) {
  return crypto.createHash('sha256').update(valor).digest('hex');
}

// A Meta exige os dados pessoais normalizados e com hash SHA-256
function hashEmail(email) {
  if (!email) return null;
  return sha256(String(email).trim().toLowerCase());
}

function hashTelefone(telefone) {
  if (!telefone) return null;
  let n = String(telefone).replace(/\D/g, '');
  if (n.length <= 11) n = '55' + n; // assume Brasil quando vier sem DDI
  return sha256(n);
}

function lerCookie(header, nome) {
  if (!header) return null;
  const achado = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(nome + '='));
  return achado ? decodeURIComponent(achado.split('=').slice(1).join('=')) : null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const origem = req.headers.origin;
  if (origem && !ORIGENS_PERMITIDAS.includes(origem)) {
    return res.status(403).json({ erro: 'Origem não autorizada' });
  }

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_CAPI_TOKEN;

  if (!PIXEL_ID || !TOKEN) {
    console.error('META_PIXEL_ID ou META_CAPI_TOKEN não configurados na Vercel');
    return res.status(500).json({ erro: 'Configuração ausente no servidor' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { event_name, event_id, event_source_url, custom_data = {}, user_data = {} } = body;

    if (!EVENTOS_PERMITIDOS.has(event_name)) {
      return res.status(400).json({ erro: 'Evento não permitido' });
    }
    if (!event_id) {
      return res.status(400).json({ erro: 'event_id obrigatório (deduplicação)' });
    }

    const cookies = req.headers.cookie;
    const ipBruto = req.headers['x-forwarded-for'] || '';
    const ip = ipBruto.split(',')[0].trim();

    // Quanto mais parâmetros aqui, maior o "Event Match Quality" no Gerenciador
    const userData = {
      client_ip_address: ip || undefined,
      client_user_agent: req.headers['user-agent'] || undefined,
      fbp: lerCookie(cookies, '_fbp') || undefined,
      fbc: lerCookie(cookies, '_fbc') || undefined,
    };

    const em = hashEmail(user_data.email);
    const ph = hashTelefone(user_data.phone);
    if (em) userData.em = [em];
    if (ph) userData.ph = [ph];

    const payload = {
      data: [
        {
          event_name,
          event_id,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          event_source_url: event_source_url || origem,
          user_data: userData,
          custom_data,
        },
      ],
      access_token: TOKEN,
    };

    if (process.env.META_TEST_EVENT_CODE) {
      payload.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const resposta = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const resultado = await resposta.json();

    if (!resposta.ok) {
      console.error('Erro da Meta:', JSON.stringify(resultado));
      return res.status(502).json({ erro: 'Meta recusou o evento', detalhe: resultado });
    }

    return res.status(200).json({ ok: true, ...resultado });
  } catch (erro) {
    console.error('Falha na CAPI:', erro);
    return res.status(500).json({ erro: 'Falha interna' });
  }
}
