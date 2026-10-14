// In-memory stand-in for `next/headers`, so route handlers and session
// code can run in tests. Wire it up in a test file with:
//
//   vi.mock('next/headers', () => import('@/test/request-context'))
//
// then `await signInAs(userId)` before calling a route.

const jar = new Map<string, string>()

export async function cookies() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }
}

export async function headers() {
  return new Headers({ 'user-agent': 'vitest' })
}

/** Clear the cookie jar (sign out the simulated browser). */
export function resetCookies() {
  jar.clear()
}

/** Create a real session for `userId` and store its cookie. */
export async function signInAs(userId: string) {
  jar.clear()
  const { createSession } = await import('@/lib/auth/session')
  await createSession(userId)
}
