/** Development provider: prints messages instead of sending them. */
export function createConsoleProvider({ log = console.log } = {}) {
  let n = 0;
  return {
    name: 'console',
    async send({ to, body }) {
      log(`[sms -> ${to}] ${body}`);
      return { id: `console-${++n}` };
    },
  };
}
