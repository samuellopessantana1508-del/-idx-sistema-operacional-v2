// Edge Function `meta-live` — ponte segura entre o Sistema Operacional IDX e a Meta Marketing API.
//
// - O token do Meta NUNCA vai para o navegador: é lido aqui, com service_role.
// - Só membros autenticados do sistema (public.user_profiles) podem chamar.
// - Leitura ao vivo: `graph_get` (insights, campanhas, conjuntos, anúncios da conta do cliente).
// - Otimização: `set_status` (pausar/ativar) e `set_budget` (orçamento diário), sempre com
//   `confirm: true`, validação de que o objeto pertence à conta do cliente e registro em
//   public.meta_action_log.
//
// Deploy: supabase functions deploy meta-live
// (SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY já existem no ambiente das Edge Functions.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.3";

const GRAPH_VERSION = "v25.0";
const GRAPH_TIMEOUT_MS = 30_000;
const MAX_BUDGET_INCREASE = 2; // novo orçamento no máximo 2x o atual por ação
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  status: number;
  code?: number | string;
  constructor(status: number, message: string, code?: number | string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function friendlyMetaError(err: any): HttpError {
  const code = err?.code;
  let msg = err?.error_user_msg || err?.message || "Erro desconhecido na Meta API.";
  if (code === 190) msg = "Token do Meta expirado ou revogado. Gere um novo token e salve em Configurar.";
  else if (code === 200 || code === 10 || code === 283) {
    msg = "O token não tem permissão para isso. Leitura exige ads_read; otimizar exige ads_management.";
  } else if (code === 17 || code === 4 || code === 613) {
    msg = "Limite de requisições da Meta atingido. Aguarde alguns minutos e tente de novo.";
  }
  return new HttpError(400, msg, code);
}

async function graphRequest(method: "GET" | "POST", url: URL, token: string, body?: URLSearchParams) {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) init.body = body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { ...init, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw friendlyMetaError(data?.error || { message: `Meta HTTP ${res.status}` });
    return data;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as Error).name === "AbortError") throw new HttpError(504, "Tempo limite ao consultar o Meta Ads.");
    throw new HttpError(502, "Falha de rede ao consultar o Meta Ads.");
  } finally {
    clearTimeout(timer);
  }
}

async function graph(
  method: "GET" | "POST",
  path: string,
  token: string,
  params: Record<string, string> = {},
) {
  const url = new URL(`https://graph.facebook.com/${path}`);
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return graphRequest("GET", url, token);
  }
  return graphRequest("POST", url, token, new URLSearchParams(params));
}

// Lê todas as páginas de uma listagem (campanhas, conjuntos, anúncios, insights).
async function graphAll(path: string, token: string, params: Record<string, string>, maxPages = 10) {
  const first = await graph("GET", path, token, params);
  let rows: unknown[] = first.data ?? [];
  let next: string | undefined = first.paging?.next;
  let pages = 1;
  while (next && pages < maxPages) {
    const url = new URL(next);
    if (url.hostname !== "graph.facebook.com") break;
    const page = await graphRequest("GET", url, token);
    rows = rows.concat(page.data ?? []);
    next = page.paging?.next;
    pages++;
  }
  return { ...first, data: rows, paging: undefined };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let userId: string | null = null;
  let userEmail: string | null = null;
  let clientId = "";
  let action = "";
  let body: any = {};

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) throw new HttpError(401, "Sessão ausente. Faça login novamente.");

    // 1) Quem está chamando?
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) throw new HttpError(401, "Sessão expirada. Faça login novamente.");
    userId = userData.user.id;
    userEmail = userData.user.email ?? null;

    const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

    // 2) É membro autorizado da equipe?
    const { data: profile } = await admin.from("user_profiles").select("id").eq("id", userId).maybeSingle();
    if (!profile) throw new HttpError(403, "Seu usuário não tem acesso ao sistema.");

    body = await req.json().catch(() => ({}));
    action = String(body.action || "");
    clientId = String(body.client_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new HttpError(400, "client_id inválido.");

    // 3) Credenciais do cliente (somente no servidor)
    const { data: creds, error: credErr } = await admin.rpc("get_client_meta_credentials", { p_client_id: clientId });
    const cred = Array.isArray(creds) ? creds[0] : null;
    if (credErr || !cred?.access_token || !cred?.ad_account_id) {
      if (action === "status") return json({ connected: false });
      throw new HttpError(404, "Conta Meta não conectada para este cliente. Use Configurar → Salvar e Conectar.");
    }
    const token: string = cred.access_token;
    const accountId: string = String(cred.ad_account_id).startsWith("act_")
      ? cred.ad_account_id
      : `act_${cred.ad_account_id}`;
    const accountNumeric = accountId.replace(/^act_/, "");

    // ── status: diagnóstico completo da conexão ───────────────────────────────
    if (action === "status") {
      const acc = await graph("GET", `${GRAPH_VERSION}/${accountId}`, token, {
        fields: "name,account_status,currency,timezone_name,amount_spent,disable_reason",
      });
      return json({ connected: true, ad_account_id: accountId, account: acc });
    }

    // ── graph_get: leitura ao vivo (somente caminhos da conta do cliente) ─────
    if (action === "graph_get") {
      const path = String(body.path || "");
      const m = path.match(/^(v\d+\.\d+)\/(act_\d+)\/(insights|campaigns|adsets|ads)$/);
      if (!m) throw new HttpError(400, "Consulta não permitida.");
      if (m[2] !== accountId) throw new HttpError(403, "Conta diferente da conectada a este cliente.");
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.params || {})) {
        if (k === "access_token") continue;
        if (typeof v === "string" || typeof v === "number") params[k] = String(v);
      }
      const data = await graphAll(path, token, params);
      return json(data);
    }

    // ── otimização ────────────────────────────────────────────────────────────
    if (action === "set_status" || action === "set_budget") {
      if (body.confirm !== true) throw new HttpError(400, "Ação não confirmada.");
      const objectType = String(body.object_type || "");
      const objectId = String(body.object_id || "");
      if (!["campaign", "adset", "ad"].includes(objectType)) throw new HttpError(400, "Tipo de objeto inválido.");
      if (!/^\d{5,25}$/.test(objectId)) throw new HttpError(400, "ID do objeto inválido.");

      const current = await graph("GET", `${GRAPH_VERSION}/${objectId}`, token, {
        fields: "name,status,effective_status,account_id,daily_budget,lifetime_budget",
      });
      if (String(current.account_id) !== accountNumeric) {
        throw new HttpError(403, "Este objeto não pertence à conta Meta do cliente.");
      }

      let after: Record<string, unknown> = {};
      let before: Record<string, unknown> = {};
      try {
        if (action === "set_status") {
          const status = String(body.status || "");
          if (!["ACTIVE", "PAUSED"].includes(status)) throw new HttpError(400, "Status inválido (use ACTIVE ou PAUSED).");
          before = { status: current.status, effective_status: current.effective_status };
          if (current.status === status) throw new HttpError(409, `Já está ${status === "ACTIVE" ? "ativo" : "pausado"}.`);
          await graph("POST", `${GRAPH_VERSION}/${objectId}`, token, { status });
          const fresh = await graph("GET", `${GRAPH_VERSION}/${objectId}`, token, { fields: "status,effective_status" });
          after = { status: fresh.status, effective_status: fresh.effective_status };
          if (fresh.status !== status) throw new HttpError(502, "A Meta não confirmou a mudança de status.");
        } else {
          if (objectType === "ad") throw new HttpError(400, "Anúncios não têm orçamento próprio.");
          const cents = Number(body.daily_budget_cents);
          if (!Number.isInteger(cents) || cents < 100) throw new HttpError(400, "Orçamento diário inválido (mínimo R$ 1,00).");
          if (!current.daily_budget) {
            throw new HttpError(409, "Este objeto não usa orçamento diário aqui (pode ser vitalício ou definido no nível acima).");
          }
          const currentCents = Number(current.daily_budget);
          before = { daily_budget_cents: currentCents };
          if (cents > currentCents * MAX_BUDGET_INCREASE) {
            throw new HttpError(400, `Aumento acima de ${MAX_BUDGET_INCREASE}x o orçamento atual não é permitido de uma vez. Aumente em etapas.`);
          }
          if (cents === currentCents) throw new HttpError(409, "O orçamento já é esse valor.");
          await graph("POST", `${GRAPH_VERSION}/${objectId}`, token, { daily_budget: String(cents) });
          const fresh = await graph("GET", `${GRAPH_VERSION}/${objectId}`, token, { fields: "daily_budget" });
          after = { daily_budget_cents: Number(fresh.daily_budget) };
          if (Number(fresh.daily_budget) !== cents) throw new HttpError(502, "A Meta não confirmou o novo orçamento.");
        }
      } catch (e) {
        await admin.from("meta_action_log").insert({
          client_id: clientId, user_id: userId, user_email: userEmail, action, object_type: objectType,
          object_id: objectId, object_name: current.name ?? null, before_value: before, after_value: null,
          ok: false, error_message: (e as Error).message,
        });
        throw e;
      }

      await admin.from("meta_action_log").insert({
        client_id: clientId, user_id: userId, user_email: userEmail, action, object_type: objectType,
        object_id: objectId, object_name: current.name ?? null, before_value: before, after_value: after, ok: true,
      });
      return json({ ok: true, object_id: objectId, name: current.name, before, after });
    }

    throw new HttpError(400, "Ação desconhecida.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("[meta-live] erro inesperado:", (e as Error).message);
    return json({ error: "Erro interno ao falar com o Meta Ads." }, 500);
  }
});
