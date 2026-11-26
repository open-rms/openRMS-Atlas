// Development-only token issuer, so the Directory's tests run without openRMS-Accounts.
// Serves OIDC discovery and JWKS like Accounts does, and mints tokens on POST /mint.
// NEVER trust this issuer outside local development (it signs whatever it is asked to).
//
//   pnpm exec tsx scripts/dev-issuer.ts            # http://localhost:8799
//   curl -s -X POST localhost:8799/mint -d '{"sub":"u1","callsign":"N0CALL"}'
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = Number(process.env.DEV_ISSUER_PORT ?? 8799);
const ISS = `http://localhost:${PORT}`;
const AUD = process.env.DIRECTORY_AUDIENCE ?? "https://directory.openrms.dev";
const { publicKey, privateKey } = await generateKeyPair("ES256");
const KID = `dev-${Date.now()}`; // new id per start, so verifiers refetch the JWKS instead of using a stale key
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };

createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}).listen(PORT, () => console.log(`dev issuer on ${ISS} (aud ${AUD})`));

async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/.well-known/openid-configuration") return send(200, { issuer: ISS, jwks_uri: `${ISS}/jwks` });
  if (req.url === "/jwks") return send(200, { keys: [jwk] });
  if (req.url === "/mint" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw || "{}") as Record<string, unknown> & { sub: string; aud?: string; expiresIn?: string; exp?: number; iat?: number };
    const { aud, expiresIn, exp, iat, ...claims } = b;
    let jwt = new SignJWT({ scope: "openid profile callsign clubs", clubs: [], callsign_verified: false, role: "user", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuer(ISS)
      .setAudience(aud ?? AUD)
      .setSubject(b.sub)
      .setExpirationTime(exp ?? expiresIn ?? "15m"); // exp: absolute unix seconds (lets tests mint expired tokens)
    jwt = iat ? jwt.setIssuedAt(iat) : jwt.setIssuedAt();
    return send(200, { token: await jwt.sign(privateKey) });
  }
  send(404, { error: "not found" });
}
