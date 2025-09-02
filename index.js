// index.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.json());

// === VARIÁVEIS DE AMBIENTE (obrigatórias) ===
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || "meu_token_de_verificacao";
const WHATS_TOKEN     = process.env.WHATS_TOKEN;           // Token Cloud API
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;       // ID numérico do número WhatsApp
const ATENDINICIO     = process.env.ATENDINICIO || "08:30";
const ATENDFIM        = process.env.ATENDFIM    || "18:00";
const ATENDDIAS       = process.env.ATENDDIAS   || "Seg a Sex";

// === DADOS DA EMPRESA (fixos, personalizados) ===
const COMPANY_NAME    = "RASTREIA SERRA RASTREAMENTO VEICULAR";
const COMPANY_ADDRESS = "Rua Maestro João Cosner, 376 – Cidade Nova – Caxias do Sul/RS";
const PAYMENT_METHODS = "Cartão de crédito/débito, Pix, boleto e dinheiro";
const SUPPORT_WHATS   = "54 98401-1516";
const SUPPORT_EMAIL   = "rastreiaserra@outlook.com";

// === ASAAS (opcional p/ cobranças/segunda via) ===
const ASAAS_API_KEY   = process.env.ASAAS_API_KEY || "";
const ASAAS_BASE      = process.env.ASAAS_BASE || "https://api.asaas.com/v3";
const asaas = ASAAS_API_KEY
  ? axios.create({ baseURL: ASAAS_BASE, headers: { "access_token": ASAAS_API_KEY } })
  : null;

// === E-MAIL (opcional p/ comprovantes) ===
const SMTP_HOST = process.env.SMTP_HOST || "";
theSMTPPORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_TO   = process.env.MAIL_TO   || "financeiro@rastreiaserra.com.br"; // destino p/ comprovantes
const mailer = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: theSMTPPORT,
      secure: theSMTPPORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

// === WEBHOOK externo (opcional p/ comprovantes) ===
const PROVAS_WEBHOOK_URL = process.env.PROVAS_WEBHOOK_URL || "";

// Proteção simples do webhook Asaas
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || "";

// ======== STATE (memória simples por número) ========
const sessions = Object.create(null);
// sessions[to] = { step, faturaId?, protocolo?, tipo?, fbScore? }
function setStep(to, step) { sessions[to] = { ...(sessions[to]||{}), step }; }
function getStep(to) { return sessions[to]?.step || null; }
function clearStep(to) { delete sessions[to]; }

// ======== HELPERS =========
function protocolo() {
  const now = new Date();
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `RS-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}-${n}`;
}
function brl(n) { return `R$ ${Number(n).toFixed(2).replace('.', ',')}`; }
function dataBR(d) { return new Date(d).toLocaleDateString("pt-BR"); }
function onlyDigits(s) { return String(s||"").replace(/\D/g, ""); }
function extractAsaasCodeFromUrl(url) {
  if (!url) return "";
  const m = String(url).match(/\/i\/([^/?#]+)/i);
  return m ? m[1] : "";
}

// envia texto (sempre sanitizando o número)
async function sendText(to, text) {
  to = onlyDigits(to);
  if (!to) return;
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } }
  );
}

/* ===============================
   TEMPLATES (4 principais) + 2ª via
   =============================== */

// 1) Cobrança nova (link no corpo) — template: cobranca_nova_v2
async function sendTemplateCobrancaNova(to, { nome, descricao, valorBR, vencimentoBR, link }) {
  to = onlyDigits(to);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "cobranca_nova_v2",
      language: { code: "pt_BR" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: nome || "Cliente" },      // {{1}}
          { type: "text", text: descricao || "Cobrança" },// {{2}}
          { type: "text", text: valorBR || "" },          // {{3}}
          { type: "text", text: vencimentoBR || "" },     // {{4}}
          { type: "text", text: link || "" }              // {{5}}
        ]
      }]
    }
  };
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload,
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } });
}

// 2) Lembrete de vencimento — template: lembrete_vencimento_v1 (botão URL com sufixo {{1}})
async function sendTemplateLembreteVencimento(to, { nome, descricao, valorBR, vencimentoBR, linkCode }) {
  to = onlyDigits(to);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "lembrete_vencimento_v1",
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: nome || "Cliente" },       // {{1}}
            { type: "text", text: descricao || "Cobrança" }, // {{2}}
            { type: "text", text: valorBR || "" },           // {{3}}
            { type: "text", text: vencimentoBR || "" }       // {{4}}
          ]
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: linkCode || "" }]
        }
      ]
    }
  };
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload,
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } });
}

// 3) Cobrança em atraso — template: cobranca_atraso_v1 (botão URL + quick reply)
async function sendTemplateCobrancaAtraso(to, { nome, descricao, valorBR, vencimentoBR, linkCode }) {
  to = onlyDigits(to);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "cobranca_atraso_v1",
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: nome || "Cliente" },       // {{1}}
            { type: "text", text: descricao || "Cobrança" }, // {{2}}
            { type: "text", text: valorBR || "" },           // {{3}}
            { type: "text", text: vencimentoBR || "" }       // {{4}}
          ]
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: linkCode || "" }]
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: "AJUDA_COBRANCA" }]
        }
      ]
    }
  };
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload,
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } });
}

// 4) Pagamento confirmado — template: pagamento_confirmado_v1
async function sendTemplatePagamentoConfirmado(to, { nome, descricao, valorBR, dataPagamentoBR }) {
  to = onlyDigits(to);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "pagamento_confirmado_v1",
      language: { code: "pt_BR" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: nome || "Cliente" },             // {{1}}
          { type: "text", text: descricao || "Cobrança" },       // {{2}}
          { type: "text", text: valorBR || "" },                 // {{3}}
          { type: "text", text: dataPagamentoBR || "" }          // {{4}}
        ]
      }]
    }
  };
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload,
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } });
}

// (extra) Segunda via — template: segunda_via_fatura
async function sendTemplateSegundaVia(to, { nome, faturaId, vencimentoBR, valorBR, url }) {
  to = onlyDigits(to);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "segunda_via_fatura",   // nome APROVADO
      language: { code: "pt_BR" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: nome || "" },
          { type: "text", text: faturaId || "" },
          { type: "text", text: vencimentoBR || "" },
          { type: "text", text: valorBR || "" },
          { type: "text", text: url || "" }
        ]
      }]
    }
  };
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload,
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } });
}

/* ===========================================
   MENUS / FLUXOS (principal, planos, suporte, financeiro)
   =========================================== */

function menuPrincipal() {
  return (
`🤖 *Atendimento ${COMPANY_NAME}*

1️⃣ Planos e Preços
2️⃣ Suporte Técnico
3️⃣ Financeiro
4️⃣ Falar com atendente

Envie o número da opção ou escreva seu pedido.`
  );
}

const PRICE_MENSAL = 49.90; // R$ por veículo/mês (1 a 3)
const FEE_ADESAO   = 100.00; // R$ por veículo

function menuPlanos() {
  return (
`*Selecione o tipo de veículo:*
1) Carro de passeio
2) Moto
3) Caminhão
4) Ônibus
5) Veículo agrícola
6) Embarcação
7) Gerador
8) Utilitário

9) Retornar ao menu principal
10) Falar com atendente
0) Encerrar atendimento`
  );
}
const TIPOS_VEICULO = {
  "1": "Carro de passeio",
  "2": "Moto",
  "3": "Caminhão",
  "4": "Ônibus",
  "5": "Veículo agrícola",
  "6": "Embarcação",
  "7": "Gerador",
  "8": "Utilitário"
};

async function fluxoPlanosIntro(to) {
  await sendText(to, `📦 *Planos e Preços*\n${menuPlanos()}`);
  setStep(to, "planos_menu");
}
async function planosPedirFormulario(to, tipo) {
  sessions[to] = { ...(sessions[to]||{}), step: "planos_form", tipo };
  await sendText(to,
`📝 *${tipo}* — formulário:
Digite em *uma única mensagem*:
Marca: ...
Modelo: ...
Ano: ...
Quantidade de veículos: ...

(digite *9* para voltar ao menu principal, *10* para atendente, *0* para encerrar)`);
}
async function planosProcessarFormulario(to, rawText) {
  const tipo = sessions[to]?.tipo || "Veículo";
  const numeros = (rawText.match(/\d+/g) || []).map(n => Number(n));
  let qtd = numeros.reverse().find(n => n >= 1 && n <= 100 && n < 1900) || 1;

  let msgPreco;
  if (qtd >= 1 && qtd <= 3) {
    const totalMensal  = PRICE_MENSAL * qtd;
    const totalAdesao  = FEE_ADESAO   * qtd;
    msgPreco =
`✅ Para *${qtd}* ${qtd>1?'veículos':'veículo'} *${tipo}*:
• Mensalidade: *${brl(PRICE_MENSAL)} por veículo* → Total: *${brl(totalMensal)}*
• Taxa de adesão: *${brl(FEE_ADESAO)} por veículo* → Total: *${brl(totalAdesao)}*`;
  } else {
    msgPreco =
`ℹ️ Para frotas acima de *3 veículos*, temos condições diferenciadas.
Posso te encaminhar a um atendente para proposta personalizada.`;
  }

  await sendText(to,
`${msgPreco}

Se desejar, envie novamente o formulário com outra quantidade.
Ou digite:
*9* voltar ao menu principal
*10* falar com atendente
*0* encerrar`);
  setStep(to, "planos_menu");
}
async function endChat(to) {
  await sendText(to, "✅ Atendimento finalizado. Quando quiser recomeçar, envie *qualquer mensagem* que eu mostro o menu.");
  setStep(to, "ended_wait_any");
}

// ——— Suporte Técnico ———
function menuSuporte() {
  return (
`🛠️ *Suporte Técnico*

1) Não consigo acessar o aplicativo
2) Meu veículo está offline na plataforma
3) Esqueci a senha e o usuário de acesso
4) Cancelar o serviço
5) Retornar ao menu anterior

Comandos rápidos:
9) Falar com atendente
0) Encerrar atendimento`
  );
}
async function fluxoSuporteIntro(to) {
  await sendText(to, menuSuporte());
  setStep(to, "suporte_menu");
}
async function suporteAcessoApp(to) {
  await sendText(to,
`🔐 *Acesso ao aplicativo — passos rápidos*
1) Verifique se a *fatura está em dia*. Em atraso, o serviço pode estar bloqueado.
2) Confira se *login e senha* foram digitados corretamente (maiúsculas/minúsculas).

Se ainda não conseguir, digite *9* para falar com um atendente, ou *0* para encerrar.`);
}
async function suporteVeiculoOffline(to) {
  await sendText(to,
`📡 *Veículo offline — como verificar*
1) O veículo está com a *chave/ignição desligada*?
2) Se o tempo offline for *menor que 1h*, pode ser apenas *hibernação* (após ~5min com chave desligada).
3) *Ligue a chave* e aguarde alguns instantes. Se não voltar online, digite *9* para falar com atendente.
Se o problema foi resolvido, digite *0* para encerrar.`);
}
async function suporteEsqueciAcessoIntro(to) {
  setStep(to, "suporte_recuperacao");
  const id = protocolo();
  sessions[to] = { ...(sessions[to]||{}), protocolo: id };
  await sendText(to,
`🧩 *Recuperação de acesso*
Não se preocupe, vamos criar um novo acesso.

Envie *em uma única mensagem*:
1) Nome completo
2) Empresa (se houver)
3) Placa do veículo

Exemplo:
Nome: João da Silva
Empresa: Rastreia Serra
Placa: ABC1D23

(Atalhos: *5* voltar, *9* atendente, *0* encerrar)
Protocolo: *${id}*`);
}
async function suporteEsqueciAcessoProcessar(to, rawText) {
  const id = sessions[to]?.protocolo || protocolo();
  await sendText(to,
`✅ Recebi os dados para criar novo acesso.
${rawText}

*Protocolo:* ${id}
Um atendente vai te auxiliar assim que possível.

(Atalhos: *5* voltar ao menu anterior, *9* atendente, *0* encerrar)`);
  setStep(to, "suporte_menu");
}
async function suporteCancelarServico(to) {
  await sendText(to,
`📬 *Cancelamento do serviço*
Para solicitar o cancelamento, envie um e-mail informando o motivo para:
✉️ *${SUPPORT_EMAIL}*

Depois de enviar o e-mail:
• Digite *5* para retornar ao menu anterior
• Ou *0* para encerrar`);
}

// ——— Financeiro ———
function menuFinanceiro() {
  return (
`💰 *Financeiro ${COMPANY_NAME}*
1️⃣ Segunda via da fatura
2️⃣ Enviar comprovante de pagamento
3️⃣ Negociação/atualização de boleto ou PIX (em breve)
9️⃣ Voltar ao menu principal

Envie o número da opção.`
  );
}
async function fluxoFinanceiroIntro(to) {
  await sendText(to, menuFinanceiro());
  setStep(to, "financeiro_menu");
}

// Asaas helpers
async function ensureAsaasCustomer({ name, email, cpfCnpj, mobilePhone }) {
  if (!asaas) throw new Error("Asaas não configurado (ASAAS_API_KEY).");
  let params = {};
  if (cpfCnpj) params.cpfCnpj = onlyDigits(cpfCnpj);
  if (email && !params.cpfCnpj) params.email = String(email).trim().toLowerCase();

  let found = null;
  if (Object.keys(params).length) {
    const { data } = await asaas.get("/customers", { params });
    found = data?.data?.[0] || null;
  }
  if (found) return found;

  const { data: created } = await asaas.post("/customers", {
    name,
    email,
    cpfCnpj: cpfCnpj ? onlyDigits(cpfCnpj) : undefined,
    mobilePhone: mobilePhone ? onlyDigits(mobilePhone) : undefined
  });
  return created;
}
async function createPaymentAndLink({ customerId, value, dueDate, billingType = "BOLETO", description = "", externalReference }) {
  if (!asaas) throw new Error("Asaas não configurado (ASAAS_API_KEY).");
  const { data: p } = await asaas.post("/payments", {
    customer: customerId,
    value: Number(value),
    dueDate,                 // "YYYY-MM-DD"
    billingType,             // "PIX" | "BOLETO" | "CREDIT_CARD"
    description,
    externalReference        // grave aqui o número WhatsApp do cliente (só dígitos)
  });

  let link = p.invoiceUrl || p.bankSlipUrl || "";
  if (!link && p.billingType === "PIX") {
    try {
      const { data } = await asaas.get(`/payments/${p.id}/pixQrCode`);
      link = data?.payload || "";
    } catch {}
  }
  return { payment: p, link };
}

async function iniciarSegundaVia(to) {
  if (!asaas) {
    await sendText(to,
`📄 *Segunda via da fatura*
Integração automática indisponível (ASAAS_API_KEY não definida).
Entre em contato: 📞 ${SUPPORT_WHATS} | ✉️ ${SUPPORT_EMAIL}`);
    clearStep(to);
    return;
  }
  await sendText(to,
`📄 *Segunda via da fatura*
Informe *CPF/CNPJ* ou *e-mail* do cadastro:
Ex.: 000.000.000-00  *ou*  cliente@empresa.com`);
  setStep(to, "financeiro_segundavia");
}
async function findCustomer({ cpfCnpj, email }) {
  const params = {};
  if (cpfCnpj) params.cpfCnpj = onlyDigits(cpfCnpj);
  if (email) params.email = email.trim().toLowerCase();
  const { data } = await asaas.get("/customers", { params });
  return data?.data?.[0] || null;
}
async function listOpenPayments(customerId) {
  const params = { customer: customerId, status: "PENDING,OVERDUE" };
  const { data } = await asaas.get("/payments", { params });
  return data?.data || [];
}
async function buildSecondCopyMessage(customerId) {
  const payments = await listOpenPayments(customerId);
  if (!payments.length) return "✅ Nenhuma cobrança pendente encontrada no seu cadastro.";

  let out = ["📄 *Faturas/2ª via encontradas:*"];
  for (const p of payments) {
    const venc = p.dueDate ? new Date(p.dueDate).toLocaleDateString("pt-BR") : "-";
    const valor = (typeof p.value === "number") ? p.value.toFixed(2).replace(".", ",") : String(p.value || "");
    let link = p.bankSlipUrl || p.invoiceUrl || "";
    if (!link && p.billingType === "PIX") {
      try {
        const { data } = await asaas.get(`/payments/${p.id}/pixQrCode`);
        link = `PIX copia-e-cola:\n${data.payload}`;
      } catch { link = "PIX disponível (erro ao gerar QR Code)."; }
    }
    out.push(`• #${p.id} | Venc.: ${venc} | Valor: R$ ${valor}\n${link || "Link indisponível"}`);
  }
  out.push("\nTambém enviamos a *segunda via* como mensagem estruturada. Se precisar de ajuda, responda com *4* para atendente.");
  return out.join("\n");
}

// ======== Comprovante (email/webhook) ========
async function iniciarComprovante(to) {
  await sendText(to,
`📎 *Enviar comprovante de pagamento*
1) Me informe o *ID/Nº da fatura* (ex.: #RS-2025-1234)
2) Em seguida, *envie o arquivo* do comprovante (imagem ou PDF).`);
  sessions[to] = { step: "financeiro_comprovante_ask_id" };
}
async function confirmarFaturaId(to, rawText) {
  const faturaId = rawText.trim();
  sessions[to] = { step: "financeiro_comprovante_wait_file", faturaId };
  await sendText(to, `Perfeito! Agora *envie o arquivo* do comprovante (foto/print ou PDF) referente à fatura *${faturaId}*.`);
}
async function obterUrlMidia(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATS_TOKEN}` }
  });
  const url = meta.data?.url;
  if (!url) throw new Error("URL de mídia não encontrada");
  const fileResp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATS_TOKEN}` }
  });
  return { buffer: Buffer.from(fileResp.data), contentType: meta.data?.mime_type || "application/octet-stream" };
}
async function enviarComprovante(destinatarioEmail, assunto, texto, filename, fileBuffer) {
  if (!mailer) return false;
  await mailer.sendMail({
    from: `"Financeiro ${COMPANY_NAME}" <${SMTP_USER}>`,
    to: destinatarioEmail,
    subject: assunto,
    text: texto,
    attachments: [{ filename, content: fileBuffer }]
  });
  return true;
}
async function postarComprovanteWebhook(url, payload) {
  if (!url) return false;
  await axios.post(url, payload, { timeout: 15000 });
  return true;
}

/* =======================
   Handoff humano + Feedback
   ======================= */

async function handoff(to) {
  setStep(to, "human_handoff");
  await sendText(to,
"👩‍💼 Ok! Vou transferir para um atendente humano.\nEnquanto isso, posso não responder.\n\nPara *encerrar* a conversa a qualquer momento, digite *encerra*.");
}
async function startFeedback(to) {
  setStep(to, "feedback_ask");
  await sendText(to, "📝 *Avalie nosso atendimento*\nDe *1 a 5*, como você nos avalia?\n(1 = péssimo, 5 = excelente)");
}
async function finishFeedback(to) {
  await sendText(to, "✅ Obrigado pelo feedback!\n*Atendimento finalizado.* Quando quiser recomeçar, envie *qualquer mensagem* e eu mostro o menu.");
  setStep(to, "ended_wait_any");
}
async function boasVindas(to, nomeGuess) {
  await sendText(to,
`Olá${nomeGuess ? `, ${nomeGuess}` : ""}! 👋 Sou o assistente virtual da *${COMPANY_NAME}*.

${menuPrincipal()}

🕒 Horário: ${ATENDDIAS}, ${ATENDINICIO}–${ATENDFIM}.
📍 Endereço: ${COMPANY_ADDRESS}
💳 Pagamentos: ${PAYMENT_METHODS}
📞 Suporte: ${SUPPORT_WHATS} | ✉️ ${SUPPORT_EMAIL}

Digite *menu* a qualquer momento.`);
}

/* ===========================
   META WEBHOOK (verificação/recebimento)
   =========================== */

// Verificação do webhook (Meta) - GET
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recebimento de mensagens - POST
app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200); // responde rápido

    const change = req.body.entry?.[0]?.changes?.[0];
    const value  = change?.value || {};
    const msg    = value.messages?.[0];
    const waId   = value.contacts?.[0]?.wa_id;

    if (!msg) return;

    const to = onlyDigits(msg.from || waId);
    const type = msg.type;
    const profileName = value.contacts?.[0]?.profile?.name || "";

    const rawText = type === "text" ? (msg.text?.body || "") : "";
    const text = rawText.trim().toLowerCase();

    const chamaMenu = ["oi","olá","ola","bom dia","boa tarde","boa noite","menu","iniciar","start"];
    const step = getStep(to);

    // Quick reply do template de atraso
    if (type === "button" && msg?.button?.payload === "AJUDA_COBRANCA") {
      await handoff(to);
      return;
    }

    /* --------- ESTADOS DE HANDOFF/FEEDBACK ---------- */
    if (step === "human_handoff") {
      if (/(^|\b)(encerra|encerrar|finalizar|fim)(\b|$)/i.test(text)) {
        await endChat(to);
        return;
      }
      if (text === "não" || text === "nao" || text === "n") {
        await startFeedback(to);
        return;
      }
      return; // silêncio durante o handoff
    }
    if (step === "feedback_ask") {
      const m = text.match(/^[1-5]$/);
      if (!m) { await sendText(to, "Por favor, responda com um número de *1 a 5* (1 = péssimo, 5 = excelente)."); return; }
      const nota = Number(m[0]);
      sessions[to] = { ...(sessions[to]||{}), fbScore: nota };
      setStep(to, "feedback_comment");
      await sendText(to, "Obrigado! Quer deixar algum comentário? (se não quiser, responda *pular*)");
      return;
    }
    if (step === "feedback_comment") {
      const comentario = text;
      if (comentario !== "pular") {
        const nota = sessions[to]?.fbScore;
        console.log("Feedback recebido:", { to, nota, comentario });
      } else {
        console.log("Feedback sem comentário:", { to, nota: sessions[to]?.fbScore });
      }
      await finishFeedback(to);
      return;
    }
    if (step === "ended_wait_any") {
      clearStep(to);
      await boasVindas(to, profileName);
      return;
    }

    /* ------------- SUBMENUS ------------- */

    // PLANOS
    if (step === "planos_menu") {
      if (text === "9")  { clearStep(to); await boasVindas(to, profileName); return; }
      if (text === "10") { clearStep(to); await handoff(to); return; }
      if (text === "0")  { await endChat(to); return; }
      if (TIPOS_VEICULO[text]) { await planosPedirFormulario(to, TIPOS_VEICULO[text]); return; }
      await sendText(to, "Não entendi. Escolha uma opção válida:\n\n" + menuPlanos()); return;
    }
    if (step === "planos_form") {
      if (text === "9")  { clearStep(to); await boasVindas(to, profileName); return; }
      if (text === "10") { clearStep(to); await handoff(to); return; }
      if (text === "0")  { await endChat(to); return; }
      await planosProcessarFormulario(to, rawText); return;
    }

    // SUPORTE
    if (step === "suporte_menu") {
      if (text === "1" || text.includes("acessar")) { await suporteAcessoApp(to); return; }
      if (text === "2" || text.includes("offline") || text.includes("off-line")) { await suporteVeiculoOffline(to); return; }
      if (text === "3" || text.includes("esqueci")) { await suporteEsqueciAcessoIntro(to); return; }
      if (text === "4" || text.includes("cancelar")) { await suporteCancelarServico(to); return; }
      if (text === "5") { clearStep(to); await boasVindas(to, profileName); return; }
      if (text === "9") { clearStep(to); await handoff(to); return; }
      if (text === "0") { await endChat(to); return; }
      await sendText(to, "Não entendi. Escolha uma opção válida:\n\n" + menuSuporte()); return;
    }
    if (step === "suporte_recuperacao") {
      if (text === "5") { clearStep(to); await fluxoSuporteIntro(to); return; }
      if (text === "9") { clearStep(to); await handoff(to); return; }
      if (text === "0") { await endChat(to); return; }
      await suporteEsqueciAcessoProcessar(to, rawText); return;
    }

    // FINANCEIRO
    if (step === "financeiro_menu") {
      if (text === "1" || text.includes("segunda via")) { await iniciarSegundaVia(to); return; }
      if (text === "2" || text.includes("comprovante")) { await iniciarComprovante(to); return; }
      if (text === "3") {
        await sendText(to, "🔁 Negociação/atualização – em breve. Digite *4* para atendente.");
        clearStep(to); return;
      }
      if (text === "9") { clearStep(to); await boasVindas(to, profileName); return; }
      await sendText(to, "Não entendi. " + menuFinanceiro()); return;
    }
    if (step === "financeiro_segundavia") {
      if (asaas) {
        const onlyDigitsText = rawText.replace(/\D/g, "");
        const isCPFouCNPJ = onlyDigitsText.length >= 11 && onlyDigitsText.length <= 14;
        const isEmail = rawText.includes("@") && rawText.includes(".");
        if (!isCPFouCNPJ && !isEmail) { await sendText(to, "Por favor, informe *CPF/CNPJ* (11–14 dígitos) ou *e-mail* válido."); return; }
        try {
          const cust = await findCustomer({ cpfCnpj: isCPFouCNPJ ? rawText : undefined, email: isEmail ? rawText : undefined });
          if (!cust) { await sendText(to, "Não encontrei cadastro no Asaas com esse CPF/CNPJ ou e-mail. Tente novamente ou digite *4* para atendente."); return; }

          const msgOut = await buildSecondCopyMessage(cust.id);
          await sendText(to, msgOut);

          try {
            const payments = await listOpenPayments(cust.id);
            const nomeCliente = cust.name || profileName || "Cliente";
            for (const p of payments) {
              const vencimentoBR = p.dueDate ? new Date(p.dueDate).toLocaleDateString("pt-BR") : "";
              const valorBR = (typeof p.value === "number") ? p.value.toFixed(2).replace(".", ",") : String(p.value || "");
              let url = p.bankSlipUrl || p.invoiceUrl || "";
              if (!url && p.billingType === "PIX") {
                try { const { data: pix } = await asaas.get(`/payments/${p.id}/pixQrCode`); url = pix.payload || ""; } catch (_) {}
              }
              if (url) {
                await sendTemplateSegundaVia(to, { nome: nomeCliente, faturaId: p.id, vencimentoBR, valorBR, url });
              }
            }
          } catch (e) { console.error("Falha ao enviar template segunda via:", e?.response?.data || e); }

          clearStep(to); return;
        } catch (e) {
          console.error(e?.response?.data || e);
          await sendText(to, "Tive um problema para consultar agora. Tente novamente em instantes.");
          clearStep(to); return;
        }
      } else {
        await sendText(to, "Integração Asaas não configurada. Defina *ASAAS_API_KEY*.");
        clearStep(to); return;
      }
    }
    if (step === "financeiro_comprovante_ask_id") {
      if (!rawText) { await sendText(to, "Por favor, informe o *ID/Nº da fatura* (ex.: #RS-2025-1234)."); return; }
      await confirmarFaturaId(to, rawText); return;
    }
    if (step === "financeiro_comprovante_wait_file") {
      const sess = sessions[to] || {};
      const faturaId = sess.faturaId || "N/D";
      const midia =
        msg?.image ? { id: msg.image.id, mime: msg.image.mime_type, nome: `comprovante_${faturaId}.jpg` } :
        msg?.document ? { id: msg.document.id, mime: msg.document.mime_type, nome: msg.document.filename || `comprovante_${faturaId}.pdf` } :
        null;

      if (!midia) { await sendText(to, "Envie o *arquivo do comprovante* como *imagem* (foto/print) ou *documento PDF*."); return; }

      try {
        const { buffer, contentType } = await obterUrlMidia(midia.id);
        const filename = midia.nome || `comprovante_${faturaId}`;
        const registroTxt =
`Comprovante recebido via WhatsApp
Empresa: ${COMPANY_NAME}
Fatura: ${faturaId}
Remetente (WhatsApp): ${to}
Data: ${new Date().toLocaleString("pt-BR")}`;

        let enviado = false;
        if (mailer) {
          try { await enviarComprovante(MAIL_TO, `[Comprovante] ${faturaId} - ${COMPANY_NAME}`, registroTxt, filename, buffer); enviado = true; }
          catch (e) { console.error("Falha e-mail:", e?.response?.data || e); }
        }
        if (!enviado && PROVAS_WEBHOOK_URL) {
          try {
            const base64 = buffer.toString("base64");
            await postarComprovanteWebhook(PROVAS_WEBHOOK_URL, {
              company: COMPANY_NAME, faturaId, from: to, contentType, filename,
              receivedAt: new Date().toISOString(), fileBase64: base64
            });
            enviado = true;
          } catch (e) { console.error("Falha webhook:", e?.response?.data || e); }
        }

        if (enviado) {
          await sendText(to, `✅ Comprovante da fatura *${faturaId}* recebido com sucesso! Nossa equipe vai validar e retornar se necessário.`);
        } else {
          await sendText(to, `Recebi o seu arquivo, mas *não consegui registrar automaticamente* agora.\nEnvie por e-mail: ${SUPPORT_EMAIL} ou tente novamente mais tarde.`);
        }
        setStep(to, "financeiro_menu"); return;
      } catch (e) {
        console.error("Erro ao processar mídia:", e?.response?.data || e);
        await sendText(to, "Não consegui processar o arquivo agora. Tente novamente ou envie por e-mail.");
        setStep(to, "financeiro_menu"); return;
      }
    }

    /* ======= FLUXO PADRÃO (menu principal) ======= */
    if (chamaMenu.some(k => text.startsWith(k))) {
      clearStep(to); await boasVindas(to, profileName);

    } else if (
      text === "1" ||
      text.includes("plano") || text.includes("planos") ||
      text.includes("preço") || text.includes("preços") ||
      text.includes("preco") || text.includes("precos")
    ) {
      await fluxoPlanosIntro(to);

    } else if (text === "2" || text.includes("suporte")) {
      await fluxoSuporteIntro(to);

    } else if (text === "3" || text.includes("financeiro")) {
      await fluxoFinanceiroIntro(to);

    } else if (text === "4" || text.includes("atendente") || text.includes("humano")) {
      await handoff(to);

    } else if (text === "0") {
      await endChat(to);

    } else {
      await sendText(to, `Entendi sua mensagem 👌\n${menuPrincipal()}`);
    }
  } catch (e) {
    console.error("Erro no webhook:", e?.response?.data || e);
  }
});

/* ===========================================
   ENDPOINTS AUXILIARES P/ COBRANÇAS (ASAAS)
   =========================================== */

// Criar cobrança e enviar template de nova cobrança
// POST /criar-cobranca
// { "to":"5599XXXXXXXX", "nome":"João", "descricao":"Mensalidade", "valor":49.9, "vencimento":"2025-09-10", "billingType":"BOLETO", "cpfCnpj":"000.000.000-00", "email":"cliente@exemplo.com" }
app.post("/criar-cobranca", async (req, res) => {
  try {
    const { to, nome, descricao, valor, vencimento, billingType, cpfCnpj, email } = req.body || {};
    if (!to || !valor || !vencimento) return res.status(400).json({ ok:false, error:"to, valor, vencimento são obrigatórios" });
    if (!asaas) return res.status(400).json({ ok:false, error:"Asaas não configurado (ASAAS_API_KEY)" });

    const customer = await ensureAsaasCustomer({
      name: nome || "Cliente",
      email,
      cpfCnpj,
      mobilePhone: to
    });

    const { payment, link } = await createPaymentAndLink({
      customerId: customer.id,
      value: valor,
      dueDate: vencimento,
      billingType: billingType || "BOLETO",
      description: descricao || "Cobrança",
      externalReference: onlyDigits(to)
    });

    await sendTemplateCobrancaNova(to, {
      nome: customer.name || nome || "Cliente",
      descricao: descricao || "Cobrança",
      valorBR: brl(valor),
      vencimentoBR: dataBR(vencimento),
      link: link || ""
    });

    return res.json({ ok:true, paymentId: payment.id, link });
  } catch (e) {
    console.error("Erro /criar-cobranca:", e?.response?.data || e);
    return res.status(500).json({ ok:false, error: e?.message || "erro" });
  }
});

// Webhook do Asaas — venceu, pagou etc.
// Configure no Asaas: https://SEU-APP.onrender.com/webhook/asaas?token=SEU_TOKEN
app.post("/webhook/asaas", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (!ASAAS_WEBHOOK_TOKEN || token !== ASAAS_WEBHOOK_TOKEN) {
      return res.sendStatus(403);
    }
    res.sendStatus(200); // confirma rápido ao Asaas

    const event = req.body?.event || req.body?.type || "";
    const p = req.body?.payment || req.body?.data?.payment || req.body?.data || {};
    if (!p) return;

    const status = p.status || ""; // PENDING, OVERDUE, RECEIVED, CONFIRMED...
    const customerId = p.customer || "";
    const nome = p.customer?.name || "Cliente";
    const descricao = p.description || "Cobrança";
    const valorBR = typeof p.value === "number" ? brl(p.value) : String(p.value || "");
    const vencimentoBR = p.dueDate ? dataBR(p.dueDate) : "";
    const link = p.invoiceUrl || p.bankSlipUrl || "";

    // tentar número do WhatsApp salvo no externalReference
    let to = onlyDigits(p.externalReference || "");
    // fallback: buscar telefone do customer
    if (!to && asaas && customerId) {
      try {
        const { data: cust } = await asaas.get(`/customers/${customerId}`);
        let phone = cust?.mobilePhone || cust?.phone || "";
        phone = onlyDigits(phone);
        if (phone && phone.length === 11) phone = "55" + phone;
        to = phone;
      } catch (e) { console.error("Asaas get customer fail:", e?.response?.data || e); }
    }
    if (!to) { console.log("Sem telefone para notificar."); return; }

    // Extrai código curto do Asaas (para botões de URL)
    const linkCode = extractAsaasCodeFromUrl(link);

    // Atraso
    if (/OVERDUE/i.test(status)) {
      if (linkCode) {
        await sendTemplateCobrancaAtraso(to, { nome, descricao, valorBR, vencimentoBR, linkCode });
      } else {
        // Sem código; envia versão "nova" com link no corpo
        await sendTemplateCobrancaNova(to, { nome, descricao, valorBR, vencimentoBR, link });
      }
      return;
    }

    // Criado (opcional reenvio)
    if (/CREATED/i.test(event)) {
      if (link) {
        await sendTemplateCobrancaNova(to, { nome, descricao, valorBR, vencimentoBR, link });
      }
      return;
    }

    // Recebido/Confirmado (pagamento ok)
    if (/RECEIVED|CONFIRMED/i.test(status)) {
      const dataPagamentoBR = new Date().toLocaleDateString("pt-BR");
      await sendTemplatePagamentoConfirmado(to, { nome, descricao, valorBR, dataPagamentoBR });
      return;
    }
  } catch (e) {
    console.error("Erro /webhook/asaas:", e?.response?.data || e);
  }
});

/* ======================
   SERVIDOR
   ====================== */
app.listen(process.env.PORT || 3000, () => console.log("Bot online"));
