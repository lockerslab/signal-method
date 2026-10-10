// Función del Clasificador (Signal Method).
// - El prompt se arma ACÁ, en el servidor. El navegador solo manda campos estructurados.
// - Límite de uso por IP y por día + tope global diario del sitio (Netlify Blobs).
// - Solo acepta pedidos desde el propio sitio (Origin/Referer).
// - Errores sin detalles internos.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

// claude-sonnet-4-20250514 fue retirado por Anthropic el 15/06/2026 (devuelve 404). Reemplazo oficial: claude-sonnet-5-5.
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = 1000;

// Límites diarios (se reinician a las 00:00 UTC = 21:00 hora de Buenos Aires).
// Se pueden ajustar sin tocar código con variables de entorno del sitio.
const LIMIT_PER_IP = Number(process.env.RL_IP_PER_DAY) || 40;
const LIMIT_SITE = Number(process.env.RL_SITE_PER_DAY) || 200;
const STORE_NAME = "rate-limit";

const SITE_NAME = "signalmethod";
const ALLOWED_HOSTS = new Set([`${SITE_NAME}.netlify.app`]);
// URLs de deploy (borradores, previews, deploys puntuales): <algo>--signalmethod.netlify.app
const DEPLOY_HOST_RE = new RegExp(`^[a-z0-9-]+--${SITE_NAME}\\.netlify\\.app$`);

const LIMITS = { empresa: 200, pais: 60, industria: 80, tamano: 60, senales: 2000, contexto: 2000 };
const ALLOWED_KEYS = new Set(["modo", ...Object.keys(LIMITS)]);

const MSG = {
  method: "Método no permitido.",
  origin: "Este servicio solo funciona desde el Clasificador del Signal Method.",
  invalid: "Los datos enviados no son válidos. Revisá el formulario e intentá de nuevo.",
  ip: "Llegaste al límite de clasificaciones de hoy. ¡Gracias por usar tanto el Clasificador! Volvé a probar mañana.",
  site: "El Clasificador está con mucha demanda hoy y alcanzó su tope diario. Volvé a probar mañana, ¡perdón la molestia!",
  upstream: "No pudimos clasificar en este momento. Probá de nuevo en un ratito.",
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
const fail = (status, key) => json(status, { error: MSG[key] });

function hostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(u.hostname) || DEPLOY_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

function originOk(req) {
  const origin = req.headers.get("origin");
  if (origin) return hostAllowed(origin);
  const referer = req.headers.get("referer");
  if (referer) return hostAllowed(referer);
  return false;
}

const clean = (v, max) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);

function parseInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const k of Object.keys(body)) if (!ALLOWED_KEYS.has(k)) return null; // nada de prompts/mensajes libres
  const modo = body.modo === undefined ? "individual" : body.modo;
  if (modo !== "individual" && modo !== "batch") return null;
  const f = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = body[k];
    if (v === undefined || v === null) { f[k] = ""; continue; }
    if (typeof v !== "string" && typeof v !== "number") return null;
    f[k] = clean(String(v), max);
  }
  if (modo === "individual" && (!f.empresa || !f.senales)) return null;
  if (modo === "batch" && !f.empresa && !f.senales) return null;
  return { modo, ...f };
}

// Plantillas idénticas a las que antes armaba el navegador.
function buildPrompt(d) {
  if (d.modo === "batch") {
    return `Sos el motor de clasificación del Signal Method, framework de demand generation B2B para LATAM.

Estados:
- ROJO: Sin señal activa. Educación largo plazo.
- AMARILLO: Señal débil. Nurturing suave.
- NARANJA: Señal moderada. Abrir conversación.
- VERDE: Señal fuerte. Contacto directo ahora.

PROSPECTO:
Empresa: ${d.empresa}
Señales detectadas: ${d.senales}
Contexto: ${d.contexto || "No proporcionado"}

Respondé SOLO con JSON válido, sin texto adicional:
{"clasificacion":"ROJO|AMARILLO|NARANJA|VERDE","nivel_confianza":1-10,"resumen":"2 oraciones de diagnóstico","senales_clave":["s1","s2"],"acciones_recomendadas":["a1","a2","a3"],"advertencia":"texto o null"}`;
  }
  return `Sos el motor de clasificación del Signal Method, un framework de demand generation B2B para el mercado LATAM.

Clasificás prospectos en 4 estados según señales observables de comportamiento:
- ROJO: Sin señal activa. Sin intención de compra ni síntomas de dolor. Acción: educación largo plazo.
- AMARILLO: Señal débil. Indicios leves, sin urgencia. Acción: nurturing suave, contenido relevante.
- NARANJA: Señal moderada. Comportamiento activo pero sin urgencia de compra aún. Acción: contacto con valor, abrir conversación.
- VERDE: Señal fuerte. Dolor activo, urgencia o intención clara de compra. Acción: outreach directo, propuesta de valor.

PROSPECTO A CLASIFICAR:
- Empresa: ${d.empresa}
- País: ${d.pais || "No especificado"}
- Industria: ${d.industria || "No especificada"}
- Tamaño: ${d.tamano || "No especificado"}
- Señales detectadas: ${d.senales}
- Contexto de la empresa: ${d.contexto || "No proporcionado"}

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, sin markdown:
{
  "clasificacion": "ROJO|AMARILLO|NARANJA|VERDE",
  "nivel_confianza": 1-10,
  "resumen": "2-3 oraciones explicando el diagnóstico específico para esta empresa",
  "senales_clave": ["señal 1", "señal 2", "señal 3"],
  "acciones_recomendadas": ["acción concreta 1", "acción concreta 2", "acción concreta 3"],
  "advertencia": "texto si hay algo importante a considerar, o null si no hay"
}`;
}

// Clave de IP para el límite. En IPv6 se usa el bloque /64 (una misma conexión
// puede rotar el resto de la dirección y así esquivaría el límite).
function ipKeyPart(ip) {
  if (!ip) return "sin-ip";
  if (!ip.includes(":")) return ip;
  let full = ip.split("%")[0];
  if (full.includes("::")) {
    const [a, b] = full.split("::");
    const ha = a ? a.split(":") : [];
    const hb = b ? b.split(":") : [];
    full = [...ha, ...Array(Math.max(0, 8 - ha.length - hb.length)).fill("0"), ...hb].join(":");
  }
  return full.split(":").slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

// Cuenta un uso. Devuelve null si está dentro del límite, o la clave del mensaje si se pasó.
// Se ejecuta ANTES de llamar a Anthropic.
async function consumeQuota(ip) {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = createHash("sha256").update(`${SITE_NAME}:${ipKeyPart(ip)}`).digest("hex").slice(0, 32);
  const ipKey = `${day}/ip/${ipHash}`;
  const siteKey = `${day}/site`;
  const [ipCount, siteCount] = await Promise.all([
    store.get(ipKey).then((v) => Number(v) || 0),
    store.get(siteKey).then((v) => Number(v) || 0),
  ]);
  if (ipCount >= LIMIT_PER_IP) return "ip";
  if (siteCount >= LIMIT_SITE) return "site";
  await Promise.all([store.set(ipKey, String(ipCount + 1)), store.set(siteKey, String(siteCount + 1))]);
  return null;
}

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "method");
  if (!originOk(req)) return fail(403, "origin");

  const raw = await req.text();
  if (raw.length > 12000) return fail(400, "invalid");
  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, "invalid"); }
  const data = parseInput(body);
  if (!data) return fail(400, "invalid");

  let over;
  try {
    over = await consumeQuota(context.ip);
  } catch (e) {
    console.error("rate-limit store error", e?.message);
    return fail(503, "upstream"); // si no podemos contar, no gastamos
  }
  if (over) return fail(429, over);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: buildPrompt(data) }] }),
    });
    if (!r.ok) {
      console.error("anthropic status", r.status);
      return fail(502, "upstream");
    }
    const out = await r.json();
    const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    // Misma forma que antes ({content:[{text}]}) para no cambiar el front, sin datos extra.
    return json(200, { content: [{ type: "text", text }] });
  } catch (e) {
    console.error("anthropic error", e?.message);
    return fail(502, "upstream");
  }
};
