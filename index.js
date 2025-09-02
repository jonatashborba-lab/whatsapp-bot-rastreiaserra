// index.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const nodemailer = require("nodemailer");

const app = express();
// === Verificação do Webhook (GET) === app.get('/webhook', (req, res) => {   const VERIFY_TOKEN = process.env.VERIFY_TOKEN;   const mode = req.query['hub.mode'];   const token = req.query['hub.verify_token'];   const challenge = req.query['hub.challenge'];    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {     console.log('Webhook verificado com sucesso');     return res.status(200).send(challenge);   }   return res.sendStatus(403); });  // === Recebe eventos do WhatsApp (POST) e responde === app.post('/webhook', async (req, res) => {   try {     // Responde 200 imediatamente para a Meta     res.sendStatus(200);      const value = req.body?.entry?.[0]?.changes?.[0]?.value || {};     const msg   = value.messages?.[0];                 // mensagem recebida     const waId  = value.contacts?.[0]?.wa_id;          // wa_id do contato      if (!msg) return; // ignora eventos sem mensagem do usuário      // >>> DESTINATÁRIO: quem enviou a mensagem (somente dígitos, sem +)     const to = String(msg.from || waId || '').replace(/\D/g, '');     console.log('>> Enviando resposta para:', to);      // Texto recebido     const textIn = (msg.text?.body || '').trim().toLowerCase();      // Resposta padrão / menu     let resposta = 'Digite *menu* para começar.';     if (['menu', 'inicio', 'início'].includes(textIn)) {       resposta = [         '1 Orçamento',         '2 Suporte',         '3 Financeiro',         '4 Outros assuntos'       ].join('
');     } else if (textIn === '3') {       resposta = 'Financeiro:
1 - Segunda via da fatura
Escreva: *2via* para receber o link.';     } else if (['2via', 'segunda via', 'fatura'].includes(textIn)) {       resposta = 'Para segunda via, informe seu CPF/CNPJ ou número do contrato.';     }      // Envia a resposta     await axios.post(       `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,       {         messaging_product: 'whatsapp',         to,         type: 'text',         text: { body: resposta }       },       { headers: { Authorization: `Bearer ${process.env.WHATS_TOKEN}` } }     );   } catch (err) {     console.error('Erro ao responder:', err.response?.data || err.message || err);   } });());

// === VARIÁVEIS DE AMBIENTE (obrigatórias) ===
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || "meu_token_de_verificacao";
const WHATS_TOKEN     = process.env.WHATS_TOKEN;           // Token Cloud API (permanente)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;       // ID do número do WhatsApp
const ATENDINICIO     = process.env.ATENDINICIO || "08:30";
const ATENDFIM        = process.env.ATENDFIM    || "18:00";
const ATENDDIAS       = process.env.ATENDDIAS   || "Seg a Sex";

// === DADOS DA EMPRESA (fixos, personalizados) ===
const COMPANY_NAME    = "RASTREIA SERRA RASTREAMENTO VEICULAR";
const COMPANY_ADDRESS = "Rua Maestro João Cosner, 376 – Cidade Nova – Caxias do Sul/RS";
const PAYMENT_METHODS = "Cartão de crédito/débito, Pix, boleto e dinheiro";
const SUPPORT_WHATS   = "54 98401-1516";
const SUPPORT_EMAIL   = "rastreiaserra@outlook.com";

// === ASAAS (opcional p/ segunda via) ===
const ASAAS_API_KEY   = process.env.ASAAS_API_KEY || "";
const ASAAS_BASE      = process.env.ASAAS_BASE || "https://api.asaas.com/v3";
const asaas = ASAAS_API_KEY
  ? axios.create({ baseURL: ASAAS_BASE, headers: { "access_token": ASAAS_API_KEY } })
  : null;

// === E-MAIL (opcional p/ comprovantes) ===
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_TO   = process.env.MAIL_TO   || "financeiro@rastreiaserra.com.br"; // destino p/ comprovantes
const mailer = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

// === WEBHOOK externo (opcional p/ comprovantes) ===
const PROVAS_WEBHOOK_URL = process.env.PROVAS_WEBHOOK_URL || "";

// ======== STATE (memória simples por número) ========
const sessions = Object.create(null);
// sessions[from] = { step, faturaId? }
function setStep(from, step) { sessions[from] = { ...(sessions[from]||{}), step }; }
function getStep(from) { return sessions[from]?.step || null; }
function clearStep(from) { delete sessions[from]; }

// ======== HELPERS =========
function protocolo() {
  const now = new Date();
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `RS-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}-${n}`;
}

async function sendText(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } }
  );
}

async function sendTemplateSegundaVia(to, { nome, faturaId, vencimentoBR, valorBR, url }) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "segunda_via_fatura",   // nome do template APROVADO (pt_BR)
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: nome || "" },
            { type: "text", text: faturaId || "" },
            { type: "text", text: vencimentoBR || "" },
            { type: "text", text: valorBR || "" },
            { type: "text", text: url || "" }
          ]
        }
      ]
    }
  };

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${WHATS_TOKEN}` } }
  );
}

function menuPrincipal() {
  return (
`🤖 *Atendimento ${COMPANY_NAME}*

1️⃣ Orçamento
2️⃣ Suporte
3️⃣ Financeiro
4️⃣ Outros assuntos

Envie o número da opção ou escreva uma frase com seu pedido.`
  );
}

async function boasVindas(to, nomeGuess) {
  const msg =
`Olá${nomeGuess ? `, ${nomeGuess}` : ""}! 👋 Sou o assistente virtual da *${COMPANY_NAME}*.

${menuPrincipal()}

🕒 Horário: ${ATENDDIAS}, ${ATENDINICIO}–${ATENDFIM}.
📍 Endereço: ${COMPANY_ADDRESS}
💳 Pagamentos: ${PAYMENT_METHODS}
📞 Suporte: ${SUPPORT_WHATS} | ✉️ ${SUPPORT_EMAIL}

Digite *menu* a qualquer momento.`;
  await sendText(to, msg);
}

// ======== FLUXOS PRINCIPAIS ========
async function fluxoOrcamento(to) {
  const id = protocolo();
  await sendText(to,
`📝 *Orçamento*
Me informe os detalhes do rastreamento/serviço:
• Tipo de veículo
• Cidade/CEP
• Prazo ou data
• Orçamento aproximado

Protocolo: *${id}*`);
}

async function fluxoSuporte(to) {
  await sendText(to,
`🛠️ *Suporte ${COMPANY_NAME}*
Descreva o problema em uma frase (ex.: "não consigo acessar", "dúvida técnica").
📞 ${SUPPORT_WHATS} | ✉️ ${SUPPORT_EMAIL}
Se preferir, digite *4* para falar com um atendente.`);
}

async function fluxoOutros(to) {
  await sendText(to,
`🗂️ *Outros assuntos*
Escreva seu pedido em uma frase, ou digite *4* para falar com um atendente.`);
}

async function handoff(to) {
  await sendText(to, "👩‍💼 Ok! Vou transferir para um atendente humano. Aguarde um instante.");
  // aqui você pode notificar seu time por e-mail/Slack/WhatsApp interno
}

// ======== FINANCEIRO ========
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

// --- Segunda via (Asaas) ---
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

// --- Asaas helpers ---
async function findCustomer({ cpfCnpj, email }) {
  const params = {};
  if (cpfCnpj) params.cpfCnpj = cpfCnpj.replace(/\D/g, "");
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
      } catch {
        link = "PIX disponível (erro ao gerar QR Code).";
      }
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
  // 1) metadados para URL temporária
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATS_TOKEN}` }
  });
  const url = meta.data?.url;
  if (!url) throw new Error("URL de mídia não encontrada");
  // 2) baixa o binário
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

// ======== WEBHOOKS ========
// Verificação do webhook (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Recebimento de mensagens
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body.entry?.[0]?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    const from = msg?.from;
    if (!from) return res.sendStatus(200);

    const profileName = change?.value?.contacts?.[0]?.profile?.name;
    const type = msg.type;
    const rawText = type === "text" ? (msg.text.body || "").trim() : "";
    const text = rawText.toLowerCase();

    const chamaMenu = ["oi","olá","ola","bom dia","boa tarde","boa noite","menu","iniciar","start"];
    const step = getStep(from);

    // ======= SUBMENU FINANCEIRO =======
    if (step === "financeiro_menu") {
      if (text === "1" || text.includes("segunda via")) {
        await iniciarSegundaVia(from);
        return res.sendStatus(200);
      } else if (text === "2" || text.includes("comprovante")) {
        await iniciarComprovante(from);
        return res.sendStatus(200);
      } else if (text === "3") {
        await sendText(from, "🔁 Negociação/atualização – em breve. Digite *4* para falar com atendente.");
        clearStep(from);
        return res.sendStatus(200);
      } else if (text === "9") {
        clearStep(from);
        await boasVindas(from, profileName);
        return res.sendStatus(200);
      } else {
        await sendText(from, "Não entendi. " + menuFinanceiro());
        return res.sendStatus(200);
      }
    }

    // ======= Segunda via: coletar identificador e responder + template =======
    if (step === "financeiro_segundavia") {
      if (asaas) {
        const onlyDigits = rawText.replace(/\D/g, "");
        const isCPFouCNPJ = onlyDigits.length >= 11 && onlyDigits.length <= 14;
        const isEmail = rawText.includes("@") && rawText.includes(".");
        if (!isCPFouCNPJ && !isEmail) {
          await sendText(from, "Por favor, informe *CPF/CNPJ* (11–14 dígitos) ou *e-mail* válido.");
          return res.sendStatus(200);
        }
        try {
          const cust = await findCustomer({
            cpfCnpj: isCPFouCNPJ ? rawText : undefined,
            email: isEmail ? rawText : undefined
          });
          if (!cust) {
            await sendText(from, "Não encontrei cadastro no Asaas com esse CPF/CNPJ ou e-mail. Tente novamente ou digite *4* para atendente.");
            return res.sendStatus(200);
          }

          // mensagem em texto (lista)
          const msgOut = await buildSecondCopyMessage(cust.id);
          await sendText(from, msgOut);

          // envio de templates por fatura
          try {
            const payments = await listOpenPayments(cust.id);
            const nomeCliente = cust.name || profileName || "Cliente";
            for (const p of payments) {
              const vencimentoBR = p.dueDate ? new Date(p.dueDate).toLocaleDateString("pt-BR") : "";
              const valorBR = (typeof p.value === "number") ? p.value.toFixed(2).replace(".", ",") : String(p.value || "");
              let url = p.bankSlipUrl || p.invoiceUrl || "";
              if (!url && p.billingType === "PIX") {
                try {
                  const { data: pix } = await asaas.get(`/payments/${p.id}/pixQrCode`);
                  url = pix.payload || "";
                } catch (_) {}
              }
              if (url) {
                await sendTemplateSegundaVia(from, {
                  nome: nomeCliente,
                  faturaId: p.id,
                  vencimentoBR,
                  valorBR,
                  url
                });
              }
            }
          } catch (e) {
            console.error("Falha ao enviar template segunda via:", e?.response?.data || e);
          }

          clearStep(from);
          return res.sendStatus(200);
        } catch (e) {
          console.error(e?.response?.data || e);
          await sendText(from, "Tive um problema para consultar agora. Tente novamente em instantes.");
          clearStep(from);
          return res.sendStatus(200);
        }
      } else {
        await sendText(from, "Integração Asaas não configurada. Defina *ASAAS_API_KEY*.");
        clearStep(from);
        return res.sendStatus(200);
      }
    }

    // ======= Comprovante: pedir ID, receber arquivo e registrar =======
    if (step === "financeiro_comprovante_ask_id") {
      if (!rawText) { await sendText(from, "Por favor, informe o *ID/Nº da fatura* (ex.: #RS-2025-1234)."); return res.sendStatus(200); }
      await confirmarFaturaId(from, rawText);
      return res.sendStatus(200);
    }

    if (step === "financeiro_comprovante_wait_file") {
      const sess = sessions[from] || {};
      const faturaId = sess.faturaId || "N/D";

      // mídia: imagem ou documento
      const midia =
        msg?.image ? { id: msg.image.id, mime: msg.image.mime_type, nome: `comprovante_${faturaId}.jpg` } :
        msg?.document ? { id: msg.document.id, mime: msg.document.mime_type, nome: msg.document.filename || `comprovante_${faturaId}.pdf` } :
        null;

      if (!midia) {
        await sendText(from, "Envie o *arquivo do comprovante* como *imagem* (foto/print) ou *documento PDF*.");
        return res.sendStatus(200);
      }

      try {
        const { buffer, contentType } = await obterUrlMidia(midia.id);
        const filename = midia.nome || `comprovante_${faturaId}`;

        const registroTxt =
`Comprovante recebido via WhatsApp
Empresa: ${COMPANY_NAME}
Fatura: ${faturaId}
Remetente (WhatsApp): ${from}
Data: ${new Date().toLocaleString("pt-BR")}`;

        // 1) tentar e-mail
        let enviado = false;
        if (mailer) {
          try {
            await enviarComprovante(MAIL_TO, `[Comprovante] ${faturaId} - ${COMPANY_NAME}`, registroTxt, filename, buffer);
            enviado = true;
          } catch (e) {
            console.error("Falha e-mail:", e?.response?.data || e);
          }
        }
        // 2) tentar webhook
        if (!enviado && PROVAS_WEBHOOK_URL) {
          try {
            const base64 = buffer.toString("base64");
            await postarComprovanteWebhook(PROVAS_WEBHOOK_URL, {
              company: COMPANY_NAME,
              faturaId,
              from,
              contentType,
              filename,
              receivedAt: new Date().toISOString(),
              fileBase64: base64
            });
            enviado = true;
          } catch (e) {
            console.error("Falha webhook:", e?.response?.data || e);
          }
        }

        if (enviado) {
          await sendText(from, `✅ Comprovante da fatura *${faturaId}* recebido com sucesso! Nossa equipe vai validar e retornar se necessário.`);
        } else {
          await sendText(from, `Recebi o seu arquivo, mas *não consegui registrar automaticamente* agora.\nEnvie por e-mail: ${SUPPORT_EMAIL} ou tente novamente mais tarde.`);
        }

        clearStep(from);
        return res.sendStatus(200);
      } catch (e) {
        console.error("Erro ao processar mídia:", e?.response?.data || e);
        await sendText(from, "Não consegui processar o arquivo agora. Tente novamente ou envie por e-mail.");
        clearStep(from);
        return res.sendStatus(200);
      }
    }

    // ======= FLUXO PADRÃO =======
    if (chamaMenu.some(k => text.startsWith(k))) {
      clearStep(from);
      await boasVindas(from, profileName);
    } else if (text === "1" || text.includes("orçamento") || text.includes("orcamento")) {
      clearStep(from);
      await fluxoOrcamento(from);
    } else if (text === "2" || text.includes("suporte")) {
      clearStep(from);
      await fluxoSuporte(from);
    } else if (text === "3" || text.includes("financeiro")) {
      await fluxoFinanceiroIntro(from);
    } else if (text === "4" || text.includes("outros") || text.includes("atendente") || text.includes("humano")) {
      clearStep(from);
      await handoff(from);
    } else {
      await sendText(from, `Entendi sua mensagem 👌\n${menuPrincipal()}`);
    }

    
    res.sendStatus(200);
  } catch (e) {
    console.error(e?.response?.data || e);
    res.sendStatus(200);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Bot online"));
