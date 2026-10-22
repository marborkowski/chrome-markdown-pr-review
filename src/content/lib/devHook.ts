// The dev harness plugs mocks in through window globals. Production builds never read them: an element
// on the page with a matching id would show up as one (DOM clobbering).
export const devHook = <K extends keyof Window>(name: K): Window[K] | undefined =>
  process.env.NODE_ENV === 'production' ? undefined : window[name];
