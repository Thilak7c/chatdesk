import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import proxy from "./proxy";
import { SESSION_COOKIE } from "@/lib/auth/session-cookie";

function req(path: string, withSession: boolean) {
  const r = new NextRequest(new URL(path, "http://localhost:3000"));
  if (withSession) r.cookies.set(SESSION_COOKIE, "token");
  return r;
}

describe("proxy", () => {
  it("redirects anonymous visitors away from protected pages", () => {
    const res = proxy(req("/inbox", false));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("lets a request with a session cookie through to protected pages", () => {
    const res = proxy(req("/inbox", true));
    expect(res.headers.get("location")).toBeNull();
  });

  it("bounces signed-in users off the auth pages", () => {
    const res = proxy(req("/login", true));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
  });

  it("sends a signed-in user with an invite straight to the join page", () => {
    const res = proxy(req("/signup?invite=abc", true));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/join/abc");
  });

  it("leaves public pages alone", () => {
    const res = proxy(req("/join/abc", false));
    expect(res.headers.get("location")).toBeNull();
  });
});
