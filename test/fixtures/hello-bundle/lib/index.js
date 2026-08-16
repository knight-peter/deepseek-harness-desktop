// Fixture plugin mounted by the hello-bundle patch layer. Logs once on
// mount so the harness log panel proves the row was loaded, and provides a
// tiny service so the composed tree shows an observable contribution.
export const name = 'hello-bundle'

export const inject = []

export function apply(ctx) {
  console.log('[hello-bundle] mounted')
  ctx.provide('helloGreeting', 'hello from dsh-hello-bundle')
}
