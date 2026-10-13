#!/usr/bin/env node

// Mints a claim JWT for local /claim-page testing.
// Mirrors the contract in src/lib/claim-token.ts (HS256, aud "graffiticode-claim",
// 24h expiry, payload { sessionNamespace, sessionUuid }).
//
// Usage:
//   npx tsx scripts/mint-claim-token.ts <sessionUuid>
//
// The sessionUuid must match the X-Free-Plan-Session header value used when
// the trial items were created. The script derives sessionNamespace from
// FREE_PLAN_NAMESPACE_SALT (loaded from .env.local).

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SignJWT } from "jose";

function loadDotenv(file: string) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const repoRoot = process.cwd();
loadDotenv(path.join(repoRoot, ".env.local"));
loadDotenv(path.join(repoRoot, ".env"));

const AUDIENCE = "graffiticode-claim";
const EXPIRES_IN = "24h";

function deriveSessionNamespace(uuid: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}:${uuid}`).digest("hex");
}

async function main() {
  const sessionUuid = process.argv[2];
  if (!sessionUuid) {
    console.error("Usage: npx tsx scripts/mint-claim-token.ts <sessionUuid>");
    process.exit(1);
  }

  const salt = process.env.FREE_PLAN_NAMESPACE_SALT;
  if (!salt) {
    console.error("FREE_PLAN_NAMESPACE_SALT is not set (check .env.local).");
    process.exit(1);
  }

  const sessionNamespace = deriveSessionNamespace(sessionUuid, salt);
  const secret = new TextEncoder().encode(salt);

  const token = await new SignJWT({ sessionNamespace, sessionUuid })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(secret);

  console.log(`sessionUuid:      ${sessionUuid}`);
  console.log(`sessionNamespace: ${sessionNamespace}`);
  console.log("");
  console.log("Token:");
  console.log(token);
  console.log("");
  console.log("Claim URL (local):");
  console.log(`http://localhost:3000/claim?token=${token}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
