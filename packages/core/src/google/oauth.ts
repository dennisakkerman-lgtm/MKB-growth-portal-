import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { query } from "../db/pool.js";
import { encryptToken, decryptToken } from "../crypto.js";

/**
 * Fase 1: alleen GSC + GA4. Beide zijn 'sensitive' scopes —
 * verificatie vereist, naar verwachting geen security assessment.
 * business.manage (GBP) is 'restricted' en komt pas in fase 2.
 */
export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

function client(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forceert refresh token, ook bij herkoppelen
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/** Wisselt de code in en slaat de connectie versleuteld op. */
export async function exchangeCode(code: string, accountId: string): Promise<string> {
  const c = client();
  const { tokens } = await c.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Geen refresh token ontvangen. Verwijder de app-toegang in het Google-account en koppel opnieuw.",
    );
  }
  c.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: c });
  const { data: profile } = await oauth2.userinfo.get();

  const rows = await query<{ id: string }>(
    `insert into google_connections (account_id, google_email, refresh_token, scopes, status)
     values ($1, $2, $3, $4, 'active')
     returning id`,
    [accountId, profile.email, encryptToken(tokens.refresh_token), SCOPES],
  );
  return rows[0].id;
}

/**
 * Geauthenticeerde client voor een opgeslagen connectie.
 * googleapis ververst het access token zelf op basis van het refresh token.
 */
export async function getAuthedClient(connectionId: string): Promise<OAuth2Client> {
  const rows = await query<{ refresh_token: Buffer; status: string }>(
    `select refresh_token, status from google_connections where id = $1`,
    [connectionId],
  );
  if (rows.length === 0) throw new Error(`Connectie ${connectionId} bestaat niet`);
  if (rows[0].status === "revoked") {
    throw new Error(`Connectie ${connectionId} is ingetrokken — klant moet opnieuw koppelen`);
  }

  const c = client();
  c.setCredentials({ refresh_token: decryptToken(rows[0].refresh_token) });
  return c;
}

/** Markeert een connectie als ingetrokken zodat de UI om herkoppeling kan vragen. */
export async function markRevoked(connectionId: string, reason: string): Promise<void> {
  await query(
    `update google_connections set status = 'revoked', last_error = $2 where id = $1`,
    [connectionId, reason],
  );
}

/** Herkent de foutvormen die op een verlopen of ingetrokken grant duiden. */
export function isGrantError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return /invalid_grant|invalid_rapt|Token has been expired or revoked/i.test(msg);
}
