// Resolve the public base URL that links in invites / emails point at.
//
// Resolution order, first match wins:
//
//   1. `NEXT_PUBLIC_SITE_URL` — the operator's explicit config.
//   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — set by the reverse
//      proxy in front of the app (nginx, Caddy, Cloudflare, a managed host).
//   3. `Host` + the protocol the request arrived on — bare deployments.
//
// Paths 2 and 3 trust a client-controllable header. When
// `ALLOWED_INVITE_HOSTS` (comma-separated hostnames) is set, the derived
// host must be on that list.
//
// `strict` mode is for links that carry a secret to someone OTHER than
// the requester (password reset): there an attacker could request a
// reset for a victim with a forged Host and have the victim's token
// emailed pointing at the attacker's site. Strict mode therefore only
// accepts a header-derived host when it is allow-listed, or in
// development.

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim();
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export class SiteUrlNotConfiguredError extends Error {
  constructor() {
    super(
      'Set NEXT_PUBLIC_SITE_URL (or ALLOWED_INVITE_HOSTS) so emailed links can be generated safely',
    );
    this.name = 'SiteUrlNotConfiguredError';
  }
}

export function siteUrlFrom(
  request: Request,
  { strict = false }: { strict?: boolean } = {},
): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const allowList = parseAllowedHosts();
  const trustHeaders = !strict || allowList !== null || process.env.NODE_ENV !== 'production';
  const allowed = (host: string) =>
    !allowList || allowList.includes(host.split(':')[0].toLowerCase());

  if (trustHeaders) {
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    if (forwardedHost && allowed(forwardedHost)) {
      return `${forwardedProto || 'https'}://${forwardedHost}`;
    }

    const host = request.headers.get('host')?.trim();
    if (host && allowed(host)) {
      const proto = new URL(request.url).protocol.replace(':', '');
      return `${proto}://${host}`;
    }
  }

  console.warn('[siteUrlFrom] could not derive a trusted base URL', {
    strict,
    allowList,
  });
  throw new SiteUrlNotConfiguredError();
}
