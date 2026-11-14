// Owns the gateway route: where it comes from, when it is replaced, and whose account it
// belongs to. The gateway client asks here for a route on every call and never keeps its own.
import { ensureSandbox, type Account, type Dependencies, type Route } from './gateway.ts'
import { readDesktopSession, type DesktopSession, type SessionDependencies } from './session.ts'

export type ConnectionDeps = {
  readSession?: (deps?: SessionDependencies) => Promise<DesktopSession>
  requestRoute?: typeof ensureSandbox
  network?: Dependencies
}

type Held = { route: Route; accountKey?: string; account?: Account; appVersion?: string }

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function createConnection(deps: ConnectionDeps = {}) {
  // Node's test runner sets this for test files. A test that forgets to pass fakes must fail
  // here, not read the real keychain and act on a real account.
  if (process.env.NODE_TEST_CONTEXT && (!deps.readSession || !deps.network?.fetch)) {
    throw new Error('Tests must pass a fake session and a fake fetch to the worker.')
  }
  const readSession = deps.readSession ?? readDesktopSession
  const requestRoute = deps.requestRoute ?? ensureSandbox

  // Kept in memory only, and only for as long as this worker lives. The route and the
  // account it belongs to are always set together.
  let held: Held | undefined
  // The one load or refresh in flight, shared by every caller that arrives meanwhile.
  let pending: Promise<Route> | undefined
  // Raised by reset() and refreshRoute(). Work started under an older number may finish
  // later, but it must not install its result.
  let generation = 0

  /** Reads the desktop app and returns a route, asking for a fresh one when needed. */
  async function acquire(useCachedRoute: boolean, expectedAccountKey?: string): Promise<Held> {
    const session = await readSession(expectedAccountKey ? { expectedAccountKey } : undefined)
    if (useCachedRoute && session.route) {
      return { route: session.route, accountKey: session.account?.key, account: session.account, appVersion: session.appVersion }
    }
    if (!session.account) {
      throw failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
    }
    const route = await requestRoute(session.account, session.appVersion, deps.network)
    // The request took time. Keep the route only if the same account is still signed in.
    await readSession({ expectedAccountKey: session.account.key })
    return { route, accountKey: session.account.key, account: session.account, appVersion: session.appVersion }
  }

  function start(useCachedRoute: boolean, expectedAccountKey?: string): Promise<Route> {
    const mine = generation
    const work = acquire(useCachedRoute, expectedAccountKey)
      .then((result) => {
        if (mine !== generation) {
          throw failure('superseded', 'The Grok Bot connection changed. Try again.')
        }
        held = result
        return result.route
      })
      .finally(() => {
        if (pending === work) pending = undefined
      })
    pending = work
    return work
  }

  return {
    /** The current route, read from the desktop app the first time. */
    getRoute(): Promise<Route> {
      if (held) return Promise.resolve(held.route)
      return pending ?? start(true)
    },

    async getAccount(): Promise<{ account: Account; appVersion?: string }> {
      if (!held) await (pending ?? start(true))
      if (!held?.account) throw failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
      return { account: held.account, appVersion: held.appVersion }
    },

    /**
     * A fresh route after the gateway reported the cloud computer asleep. It must be for the
     * account the old route belonged to: if the person has switched accounts this fails with
     * `account_changed`, and nothing is kept.
     */
    refreshRoute(): Promise<Route> {
      const expectedAccountKey = held?.accountKey
      generation += 1
      held = undefined
      return start(false, expectedAccountKey)
    },

    /** Forget everything, so the next call reads the desktop app again. */
    reset(): void {
      generation += 1
      held = undefined
      pending = undefined
    }
  }
}
