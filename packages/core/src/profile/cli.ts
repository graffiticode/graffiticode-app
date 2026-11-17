// gc-profile: validate an installation profile directory.
//   npm run profile -- validate <dir>
// Exits 0 and prints the digest when valid; exits 1 listing every problem.
import { loadProfile, ProfileError } from "./load.js";

const [command, dir] = process.argv.slice(2);
if (command !== "validate" || !dir) {
  console.error("usage: gc-profile validate <profile-dir>");
  process.exit(2);
}
try {
  const loaded = loadProfile(dir);
  console.log(`valid: ${loaded.profile.installation.id} (profile v${loaded.profile.profileVersion})`);
  console.log(`digest: ${loaded.digest}`);
} catch (err) {
  if (err instanceof ProfileError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
