/* Registry of known credential backends.
 *
 * A "backend" is an external service whose credentials a compiler consumes at
 * compile time. Each backend declares one or more named fields; every field
 * becomes its own variable, bound to code by the name `<backend>-<field>`:
 *   - public  field -> `get-val-public "<backend>-<field>"`  (plaintext)
 *   - private field -> `get-val-private "<backend>-<field>"` (encrypted)
 * e.g. Learnosity → `learnosity-key` (public) and `learnosity-secret` (private).
 * The field list is open-ended, so configs with extra fields (e.g. two public
 * ids) are just more entries — no special-casing.
 *
 * The compiler translates these generic vars to the service's real field names
 * (e.g. Learnosity key→consumer_key, secret→consumer_secret).
 *
 * This registry is console-only: it drives the Credentials UI (grouped form +
 * native field labels) and server-side visibility resolution on write. It is
 * intentionally NOT in languages.ts — a backend is not 1:1 with a language and
 * may be shared.
 */

export type FieldVisibility = "public" | "private";

export interface CredentialField {
  name: string;             // var-name slug; binding var = `<backend>-<name>`
  label: string;            // native field name shown in the UI, e.g. "Key"
  visibility: FieldVisibility;
}

export interface CredentialBackend {
  key: string;              // stable id + var-name prefix, e.g. "learnosity"
  label: string;            // dropdown label, e.g. "Learnosity"
  fields: CredentialField[];
  docsUrl?: string;
}

export const CREDENTIAL_BACKENDS: CredentialBackend[] = [
  {
    key: "learnosity",
    label: "Learnosity",
    docsUrl: "https://help.learnosity.com/hc/en-us/articles/360000757957-Authenticating-API-Requests",
    fields: [
      { name: "key", label: "Key", visibility: "public" },
      { name: "secret", label: "Secret", visibility: "private" },
    ],
  },
];

// Sentinel for user-defined credentials that aren't a known backend.
export const CUSTOM_BACKEND_KEY = "custom";

export function getCredentialBackend(key: string | null | undefined): CredentialBackend | null {
  if (!key) return null;
  return CREDENTIAL_BACKENDS.find((b) => b.key === key) || null;
}

// The variable name a field binds to: `<backend>-<field>`.
export function varName(backendKey: string, fieldName: string): string {
  return `${backendKey}-${fieldName}`;
}

// Resolve a stored variable's visibility from the registry (server-authoritative
// for known backends). Returns null when the backend/field isn't recognized.
export function fieldVisibilityFor(backendKey: string, name: string): FieldVisibility | null {
  const def = getCredentialBackend(backendKey);
  if (!def) return null;
  const field = def.fields.find((f) => varName(backendKey, f.name) === name);
  return field ? field.visibility : null;
}
