// An account as a person recognizes it: its email when it has one, otherwise its
// wallet, shortened. A uid is a 40-hex wallet address, which nobody recognizes in
// full; showing it alone on the consent page made two test accounts look alike.
export function accountLabel(email: string | null | undefined, uid: string): string {
  if (email) return email;
  return /^[0-9a-f]{40}$/i.test(uid) ? `Wallet 0x${uid.slice(0, 4)}…${uid.slice(-4)}` : uid;
}
