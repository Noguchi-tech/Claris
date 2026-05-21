import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { randomUUID } from "node:crypto";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const serverStartedAt = new Date().toISOString();
const backupDir = join(root, "data", "backups");
const backupIndexFile = join(backupDir, "index.json");
const MAX_JSON_BYTES = 80 * 1024 * 1024;

const plannedCapabilities = {
  pcBackup: {
    label: "PCバックアップ",
    status: "available",
    serverRole: "同一Wi-Fi上で起動している時だけ、PWAのJSONバックアップをPCへ保存する"
  },
  restoreFromPcBackup: {
    label: "PCバックアップ復元",
    status: "available",
    serverRole: "保存済みバックアップ一覧と選択復元用のJSONを返す"
  },
  alwaysSync: {
    label: "常時同期",
    status: "planned",
    serverRole: "複数端末の常時同期や共同編集は今回の対象外"
  },
  aiSecretary: {
    label: "AI秘書化",
    status: "planned",
    serverRole: "現時点では未使用。Claris本体は外部LLMへ直接POSTしない"
  },
  residentVoice: {
    label: "音声常駐",
    status: "planned",
    serverRole: "PWA単体ではiOSの長時間バックグラウンド制限を受ける"
  },
  appleWatch: {
    label: "Apple Watch",
    status: "planned",
    serverRole: "Watch側入力とiPhone/PWAデータ同期の将来候補"
  },
  backgroundAutomation: {
    label: "バックグラウンド自動処理",
    status: "planned",
    serverRole: "PWAが閉じている間の完全自動同期は今回の前提にしない"
  }
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8"
};

function apiHeaders(extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    ...extra
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, apiHeaders());
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error("request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function ensureBackupDir() {
  mkdirSync(backupDir, { recursive: true });
}

function readBackupFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function metadataFromBackup(backup, fileName = "") {
  return {
    id: backup.id || backup.backupId || "",
    backupId: backup.id || backup.backupId || "",
    type: backup.type || backup.reason || "manual",
    createdAt: backup.createdAt || "",
    appVersion: backup.appVersion || "",
    schemaVersion: Number(backup.schemaVersion || backup.state?.schemaVersion || 0),
    deviceId: backup.deviceId || backup.state?.settings?.deviceId || "",
    counts: backup.counts || getStateCounts(extractBackupState(backup)),
    fileName
  };
}

function listBackups() {
  ensureBackupDir();
  const backups = readdirSync(backupDir)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => {
      try {
        return metadataFromBackup(readBackupFile(join(backupDir, name)), name);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  writeFileSync(backupIndexFile, JSON.stringify({ updatedAt: new Date().toISOString(), backups }, null, 2));
  return backups;
}

function findBackupById(id) {
  ensureBackupDir();
  const safeId = String(id || "");
  for (const name of readdirSync(backupDir).filter((item) => item.endsWith(".json") && item !== "index.json")) {
    const file = join(backupDir, name);
    try {
      const backup = readBackupFile(file);
      if (backup.id === safeId || backup.backupId === safeId) return { backup, fileName: name };
    } catch {}
  }
  return null;
}

function saveBackup(requestBody, fallbackType = "manual") {
  ensureBackupDir();
  const source = requestBody.backup && typeof requestBody.backup === "object" ? requestBody.backup : requestBody;
  const state = requestBody.state || extractBackupState(source);
  const createdAt = source.createdAt || new Date().toISOString();
  const id = source.id || source.backupId || `backup_${compactTimestamp(createdAt)}_${randomUUID().slice(0, 8)}`;
  const backup = {
    ...source,
    id,
    backupId: id,
    type: source.type || source.reason || requestBody.type || fallbackType,
    createdAt,
    appVersion: source.appVersion || requestBody.appVersion || "",
    schemaVersion: Number(source.schemaVersion || state?.schemaVersion || 0),
    deviceId: source.deviceId || state?.settings?.deviceId || "",
    counts: source.counts || getStateCounts(state),
    payloadJson: source.payloadJson || JSON.stringify(state || {}, null, 2)
  };
  const fileName = `claris-backup-${compactTimestamp(createdAt)}-${safeFilePart(id)}.json`;
  writeFileSync(join(backupDir, fileName), JSON.stringify(backup, null, 2));
  const backups = listBackups();
  return { backup: metadataFromBackup(backup, fileName), backups };
}

function extractBackupState(backup = {}) {
  if (backup.state && typeof backup.state === "object") return backup.state;
  if (backup.payload && typeof backup.payload === "object") return backup.payload;
  if (typeof backup.payloadJson === "string") {
    try {
      return JSON.parse(backup.payloadJson);
    } catch {
      return {};
    }
  }
  if (backup.tasks || backup.memos || backup.policies) return backup;
  return {};
}

function getStateCounts(state = {}) {
  return {
    tasks: Array.isArray(state.tasks) ? state.tasks.length : 0,
    memos: Array.isArray(state.memos) ? state.memos.length : 0,
    policies: Array.isArray(state.policies) ? state.policies.length : 0,
    departments: Array.isArray(state.departments) ? state.departments.length : 0,
    attachments: Array.isArray(state.attachments) ? state.attachments.length : 0,
    deletedItems: Array.isArray(state.deletedItems) ? state.deletedItems.length : 0
  };
}

function compactTimestamp(value) {
  return String(value || new Date().toISOString())
    .replace(/\D/g, "")
    .slice(0, 14)
    .padEnd(14, "0");
}

function safeFilePart(value) {
  return String(value || "backup").replace(/[^a-z0-9_-]/gi, "-").slice(0, 48);
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, apiHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end();
    return true;
  }
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      app: "Claris",
      mode: "local-pc-backup",
      startedAt: serverStartedAt,
      backupDir
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/capabilities") {
    sendJson(res, 200, {
      ok: true,
      capabilities: plannedCapabilities
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/backup") {
    sendJson(res, 200, {
      ok: true,
      backups: listBackups()
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/sync/pull") {
    const latest = listBackups()[0];
    const found = latest ? findBackupById(latest.id) : null;
    sendJson(res, 200, {
      ok: true,
      backup: latest || null,
      state: found ? extractBackupState(found.backup) : null
    });
    return true;
  }
  if (req.method === "POST" && (pathname === "/api/backup" || pathname === "/api/sync/push")) {
    const body = await readJsonBody(req);
    const result = saveBackup(body, pathname === "/api/sync/push" ? "scheduled" : "manual");
    sendJson(res, 200, {
      ok: true,
      backup: result.backup,
      backups: result.backups
    });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/restore") {
    const body = await readJsonBody(req);
    const found = findBackupById(body.backupId);
    if (!found) {
      sendJson(res, 404, { ok: false, error: "backup_not_found" });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      backup: metadataFromBackup(found.backup, found.fileName),
      state: extractBackupState(found.backup),
      restoredAt: new Date().toISOString()
    });
    return true;
  }
  sendJson(res, 404, {
    ok: false,
    error: "unknown_api_route"
  });
  return true;
}

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (relativePath.replace(/\\/g, "/").startsWith("data/backups/")) return null;
  const full = normalize(join(root, relativePath));
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || rel.includes(":")) return null;
  if (!existsSync(full)) return null;
  const stat = statSync(full);
  return stat.isDirectory() ? join(full, "index.html") : full;
}

createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(req, res, requestUrl.pathname).catch((error) => {
      sendJson(res, error.message === "request_too_large" ? 413 : 500, {
        ok: false,
        error: error.message || "api_error"
      });
    });
    return;
  }
  const file = resolvePath(req.url || "/");
  if (!file || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": types[extname(file)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(file).pipe(res);
}).listen(port, host, () => {
  console.log(`Claris dev server: http://${host}:${port}/`);
});
