import type { FastifyInstance } from 'fastify';

/** Accept only the browser form encoding used by the confirmation page. */
export function registerMagicLinkFormParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', {
    parseAs: 'string',
    bodyLimit: 1024,
  }, (_request, body, done) => done(null, body));
}

/**
 * Render an explicit confirmation step for an emailed magic link.
 *
 * Email security scanners routinely follow GET links. Consuming the token from
 * a GET would let a scanner steal the one-time credential before the user can
 * use it. Only the form's deliberate POST is allowed to consume the token.
 */
export function magicLinkConfirmation(token: string): string {
  const action = `/api/auth/verify?token=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Sign in to Cursus</title>
  </head>
  <body>
    <main>
      <h1>Sign in to Cursus</h1>
      <p>Confirm that you want to use this one-time sign-in link.</p>
      <form method="post" action="${action}" enctype="application/x-www-form-urlencoded">
        <button type="submit">Continue to Cursus</button>
      </form>
    </main>
  </body>
</html>`;
}
