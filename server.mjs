import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const serverStartedAt = new Date().toISOString();
const plannedCapabilities = {
  alwaysSync: {
    label: "常時同期",
    status: "planned",
    serverRole: "端末間の差分受信、競合検知、復元用スナップショット保管"
  },
  aiSecretary: {
    label: "AI秘書化",
    status: "planned",
    serverRole: "予定・メモ・タスクの整理要求を受け付け、外部LLM認証情報を端末へ出さずに中継"
  },
  residentVoice: {
    label: "音声常駐",
    status: "planned",
    serverRole: "録音後の文字起こしキュー、要約キュー、失敗時の再試行管理"
  },
  appleWatch: {
    label: "Apple Watch",
    status: "planned",
    serverRole: "Watch側の軽量入力とiPhone/PWAデータの同期境界"
  },
  backgroundAutomation: {
    label: "バックグラウンド自動処理",
    status: "planned",
    serverRole: "期限確認、通知候補、定期整理などのジョブ実行"
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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store"
    });
    res.end();
    return true;
  }
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      app: "Claris",
      mode: "local-dev",
      startedAt: serverStartedAt
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
  sendJson(res, 404, {
    ok: false,
    error: "unknown_api_route"
  });
  return true;
}

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const full = normalize(join(root, relative));
  if (!full.startsWith(root)) return null;
  if (!existsSync(full)) return null;
  const stat = statSync(full);
  return stat.isDirectory() ? join(full, "index.html") : full;
}

createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (requestUrl.pathname.startsWith("/api/") && handleApi(req, res, requestUrl.pathname)) return;
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
}).listen(port, "127.0.0.1", () => {
  console.log(`Claris dev server: http://127.0.0.1:${port}/`);
});
