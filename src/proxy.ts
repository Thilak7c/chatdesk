// src/proxy.ts

import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth/session-cookie";

// Optimistic gate only: it checks that a session cookie is present
// and redirects accordingly. It does NOT validate the session — that
// happens against the database in every route via getCurrentAccount()
// — so a stale cookie gets past here and is rejected (401) one step
// later. Keeping this DB-free keeps every navigation cheap.

const AUTH_PATHS = ["/login", "/signup", "/forgot-password"];
const PROTECTED_PATHS = [
  "/dashboard",
  "/inbox",
  "/contacts",
  "/pipelines",
  "/broadcasts",
  "/automations",
  "/settings",
  "/notifications",
];

export default function proxy(req: NextRequest) {
  const { nextUrl } = req;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  if (hasSession && AUTH_PATHS.includes(nextUrl.pathname)) {
    const url = nextUrl.clone();
    const inviteToken = nextUrl.searchParams.get("invite");
    if (inviteToken && (nextUrl.pathname === "/login" || nextUrl.pathname === "/signup")) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
    } else {
      url.pathname = "/dashboard";
    }
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (!hasSession && PROTECTED_PATHS.some((path) => nextUrl.pathname.startsWith(path))) {
    const url = nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
