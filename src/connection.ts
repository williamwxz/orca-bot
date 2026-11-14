// Owns the gateway route: where it comes from, when it is replaced, and whose account it
// belongs to. The gateway client asks here for a route on every call and never keeps its own.
import { ensureSandbox, type Dependencies, type Route } from './gateway'
import { readDesktopSession, type DesktopSession, type SessionDependencies } from './session'

export type ConnectionDeps = {
  readSession?: (deps?: SessionDependencies) => Promise<DesktopSession>
  requestRoute?: typeof ensureSandbox
  network?: Dependencies
}

export function createConnection(deps: ConnectionDeps = {}) {
  // Node's test runner sets this for test files. A test that forgets to pass fakes must fail
  // here, not read the real keychain and act on a real account.
  if (process.env.NODE_TEST_CONTEXT && (!deps.readSession || !deps.network?.fetch)) {
    throw new Error('Tests must pass a fake session and a fake fetch to the worker.')
  }
  const readSession = deps.readSession ?? readDesktopSession
  const requestRoute = deps.requestRoute ?? ensureSandbox

  // Kept in memory only, and only for as long as this worker lives.
  let route: Route | undefined
  let accountKey: string | undefined

  async function load(): Promise<Route> {
    const session = await readSession()
    accountKey = session.account?.key
    if (session.route) return session.route
    // No cached route: the app dropped it (the cloud computer slept). Ask for a fresh one.
    // readSession throws not_signed_in when there is neither a route nor an account.
    return requestRoute(session.account!, session.appVersion, deps.network)
  }

  return {
    /** The current route, read from the desktop app the first time. */
    async getRoute(): Promise<Route> {
      route ??= await load()
      return route
    },

    /**
     * A fresh route after the gateway reported the cloud computer asleep. The signed-in
     * account is checked before and after the request, so a route is never kept for an
     * account the person has since switched away from.
     */
    async refreshRoute(): Promise<Route> {
      route = undefined
      const before = await readSession({ expectedAccountKey: accountKey })
      if (!before.account) {
        throw Object.assign(new Error('Open the Grok Bot app and sign in, then retry.'), {
          code: 'not_signed_in'
        })
      }
      const fresh = await requestRoute(before.account, before.appVersion, deps.network)
      await readSession({ expectedAccountKey: before.account.key })
      accountKey = before.account.key
      route = fresh
      return fresh
    },

    /** Forget everything, so the next call reads the desktop app again. */
    reset(): void {
      route = undefined
      accountKey = undefined
    }
  }
}
