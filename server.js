// Gift-Me sandbox. Airtime and SMS use Africa's Talking when AT_API_KEY is set.
// Without a key, the same ledger still accepts the gift and records the SMS.
const http = require("http");
const fs = require("fs");
const path = require("path");

try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const AT_USERNAME = process.env.AT_USERNAME || "sandbox";
const AT_API_KEY = process.env.AT_API_KEY || "";
const PORT = Number(process.env.PORT) || 3000;
const LIVE = Boolean(AT_API_KEY) && process.env.MOCK_MODE !== "true";
const BASE = AT_USERNAME === "sandbox"
  ? "https://api.sandbox.africastalking.com"
  : "https://api.africastalking.com";

const STU = JSON.parse(fs.readFileSync(path.join(__dirname, "students.json"), "utf8"));
const SCHOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, "schools.json"), "utf8"));
const DBF = path.join(__dirname, "data.json");
let TX = [];
try { TX = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch {}
const save = () => fs.writeFileSync(DBF, JSON.stringify(TX, null, 1));

const phone = (p) => {
  p = String(p || "").replace(/[\s-]/g, "");
  if (/^\+254[17]\d{8}$/.test(p)) return p;
  if (/^0[17]\d{8}$/.test(p)) return "+254" + p.slice(1);
  if (/^254[17]\d{8}$/.test(p)) return "+" + p;
  return null;
};

async function at(apiPath, form) {
  const r = await fetch(BASE + apiPath, {
    method: "POST",
    headers: {
      apiKey: AT_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(form)
  });
  const t = await r.text();
  try { return JSON.parse(t); }
  catch { throw new Error("Africa's Talking " + r.status + ": " + t.slice(0, 180)); }
}

const rid = (prefix) => prefix + "_" + Math.random().toString(36).slice(2, 10);

async function airtime(to, amount) {
  if (!LIVE) {
    return { status: "Sent", transactionId: rid("AIRTIME"), amount: "KES " + amount, gateway: "sandbox-ledger" };
  }
  const j = await at("/version1/airtime/send", {
    username: AT_USERNAME,
    recipients: JSON.stringify([{ phoneNumber: to, amount: "KES " + amount }])
  });
  const x = (j.responses || [])[0];
  if (!x) throw new Error(j.errorMessage || "No airtime response");
  return {
    status: x.status,
    transactionId: x.requestId,
    discount: x.discount,
    amount: x.amount,
    gateway: "africastalking",
    error: x.errorMessage && x.errorMessage !== "None" ? x.errorMessage : undefined
  };
}

async function mpesa(to, amount) {
  return {
    status: "Accepted",
    transactionId: rid("MPESA"),
    amount: "KES " + amount,
    gateway: "sandbox-ledger",
    note: "M-PESA B2C is accepted on the Gift-Me sandbox ledger."
  };
}

async function sms(to, message) {
  if (!LIVE) {
    return { status: "Success", messageId: rid("SMS"), segments: Math.ceil(message.length / 153), gateway: "sandbox-ledger" };
  }
  const j = await at("/version1/messaging", { username: AT_USERNAME, to, message });
  const x = (((j.SMSMessageData || {}).Recipients) || [])[0];
  if (!x) throw new Error((j.SMSMessageData || {}).Message || "No SMS response");
  return { status: x.status, messageId: x.messageId, cost: x.cost, gateway: "africastalking" };
}

const first = (s) => s.name.split(" ")[0];
function thanks(s, what) {
  return `Hongera ${first(s)}! This is Gift-Me. Thank you for showing up, for learning, and for refusing to give up at ${s.school}. You have earned ${what}. Every class you attend, every quiz you pass, and every course you finish is a step toward the future you are building. Believe in yourself. Keep going. Ask for help when you need it, and make Kenya proud. Asante sana — we are with you.`;
}

function log(t) {
  TX.unshift({ at: new Date().toISOString(), ...t });
  TX = TX.slice(0, 200);
  save();
  return TX[0];
}

async function reward(kind, b) {
  const s = STU.find((x) => x.id === +b.student_id);
  if (!s) throw { code: 404, msg: "Unknown student_id" };
  const key = b.idempotency_key;
  if (!key) throw { code: 400, msg: "idempotency_key required" };
  const dup = TX.find((t) => t.idempotency_key === key);
  if (dup) return { ok: true, duplicate: true, ...dup.result };
  const to = phone(s.phone);
  if (!to) throw { code: 400, msg: "Bad phone number" };
  const amount = kind === "airtime" ? s.airtime : s.mpesa;
  const pay = kind === "airtime" ? await airtime(to, amount) : await mpesa(to, amount);
  if (pay.error) throw { code: 502, msg: pay.error };
  const what = kind === "airtime"
    ? `KES ${amount} airtime together with a ${s.gift}`
    : `KES ${amount} on M-PESA together with a ${s.gift}`;
  const text = thanks(s, what);
  let sm;
  try { sm = await sms(to, text); }
  catch (e) { sm = { status: "Failed", error: e.message }; }
  const result = {
    ok: true,
    gateway: pay.gateway,
    mode: LIVE ? "africastalking" : "sandbox-ledger",
    kind,
    student: s.name,
    gift: s.gift,
    amount: "KES " + amount,
    payment: pay,
    sms: sm,
    message: text
  };
  log({
    idempotency_key: key,
    kind,
    student_id: s.id,
    student: s.name,
    phone: to,
    amount,
    status: pay.status,
    transactionId: pay.transactionId,
    sms_status: sm.status,
    sms_id: sm.messageId,
    message: text,
    result
  });
  return result;
}

const body = (req) => new Promise((resolve) => {
  let d = "";
  req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try { resolve(d ? JSON.parse(d) : {}); }
    catch { resolve(Object.fromEntries(new URLSearchParams(d))); }
  });
});

const publicStudent = ({ phone, ...s }) => s;

http.createServer(async (req, res) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };
  const out = (code, obj) => {
    res.writeHead(code, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") return out(204, {});
  const u = (req.url || "/").split("?")[0];
  try {
    if (req.method === "GET" && (u === "/" || u === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    }
    if (u === "/api/health") {
      return out(200, { ok: true, gateway: LIVE ? "africastalking" : "sandbox-ledger", username: AT_USERNAME, keySet: Boolean(AT_API_KEY) });
    }
    if (u === "/api/students") return out(200, STU.map(publicStudent));
    if (u === "/api/schools") return out(200, SCHOOLS);
    if (u === "/api/transactions") {
      return out(200, TX.map(({ result, message, phone, ...t }) => t));
    }
    if (req.method !== "POST") return out(404, { ok: false, error: "Not found" });
    const b = await body(req);
    if (u === "/api/rewards/airtime") return out(200, await reward("airtime", b));
    if (u === "/api/rewards/mpesa") return out(200, await reward("mpesa", b));
    if (u === "/api/sms") {
      const to = phone(b.to);
      if (!to || !b.message) return out(400, { ok: false, error: "to and message required" });
      const s = await sms(to, b.message);
      log({ kind: "sms", phone: to, status: s.status, sms_id: s.messageId });
      return out(200, { ok: true, sms: s });
    }
    out(404, { ok: false, error: "Not found" });
  } catch (e) {
    out(e.code || 500, { ok: false, error: e.msg || e.message });
  }
}).listen(PORT, () => {
  console.log(`Gift-Me on http://localhost:${PORT}  gateway=${LIVE ? "africastalking" : "sandbox-ledger"}  key=${AT_API_KEY ? "set" : "missing"}`);
});
