// server.js
//
// Custom Node server: Next.js request handling + a Socket.io server
// on the same port for realtime inbox updates. Needs a long-running
// Node process (Docker / VPS / PaaS) — not serverless.
//
// Plain CommonJS so `node server.js` runs without a build step.
/* eslint-disable @typescript-eslint/no-require-imports */

const { createServer } = require("http");
const { createHash } = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

// Must match src/lib/auth/session-cookie.ts.
const SESSION_COOKIE = "chatdesk_session";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Small dedicated pool — the socket handshake is the only query here.
// Created after app.prepare(), once Next has loaded the .env files.
let pool;

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/** Resolve a socket handshake's session cookie to { userId, accountId }. */
async function authenticate(cookieHeader) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { rows } = await pool.query(
    `select s.user_id, p.account_id
       from sessions s
       join profiles p on p.user_id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
      limit 1`,
    [tokenHash],
  );
  return rows[0] ? { userId: rows[0].user_id, accountId: rows[0].account_id } : null;
}

app.prepare().then(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    path: "/api/socket",
  });

  // Every socket must carry a valid session. Events are scoped to the
  // caller's account room so one tenant never sees another's inbox.
  io.use(async (socket, nextFn) => {
    try {
      const identity = await authenticate(socket.handshake.headers.cookie);
      if (!identity) return nextFn(new Error("unauthorized"));
      socket.data.userId = identity.userId;
      socket.data.accountId = identity.accountId;
      nextFn();
    } catch (err) {
      console.error("[socket] auth failed:", err);
      nextFn(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`account:${socket.data.accountId}`);
    socket.join(`user:${socket.data.userId}`);
  });

  // API route handlers run in this same Node process but can't
  // otherwise reach this `io` instance, so it's stashed on the global
  // object — src/lib/socket.ts reads it from there.
  global.__chatdesk_io = io;

  httpServer.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  });
});
