# Repository Guidelines

> [CLAUDE.md](./CLAUDE.md) is authoritative where the two disagree; it carries the deploy, code-generation, and corpus-check contracts this file omits.

## Project Structure & Module Organization
- `src/pages/`: Next.js routes and API (`src/pages/api`).
- `src/components/`: React components; `src/hooks/` custom hooks.
- `src/lib/`: Core services (auth, API, embeddings); `src/utils/` helpers.
- `src/styles/`: Global/editor styles; `public/`: static assets.
- `docs/`, `scripts/` (utility scripts), `training/` (examples/data).

## Build, Test, and Development Commands
- `npm run dev`: Start dev server at `http://localhost:3000`.
- `npm run build`: Create production build.
- `npm run start`: Serve the production build.
- `npm run lint` / `npm run lint:fix`: Lint the codebase (and auto-fix).
- `npm run typecheck`: Run TypeScript checks.
- `npm run refresh`: Install local `graffiticode-*.tgz` language packages.
- Requirements: Node `>=18.17`. Configure env in `.env.local` (see `.env*`).

## Coding Style & Naming Conventions
- Language: TypeScript, React 18, Next.js 15; TailwindCSS for styling.
- Linting: ESLint (extends `next`, `next/core-web-vitals`). Keep lint- and type-clean.
- Indentation: 2 spaces; prefer concise functional components and hooks.
- Naming: PascalCase for components in `src/components` (e.g., `NewAPIKeyDialog.tsx`);
  camelCase for variables/functions; page files lower-case in `src/pages` (e.g., `items.tsx`).
- Styling: Use Tailwind utility classes; group related utilities logically.

## Testing Guidelines
- No formal runner configured. For complex logic, include lightweight Jest + RTL tests in PRs if feasible.
- Minimum bar: `npm run lint` and `npm run typecheck` must pass; manually exercise critical paths.
- Place component/unit tests near sources or under `__tests__` when added; name files `*.test.ts(x)`.

## Commit & Pull Request Guidelines
- Commits: Clear, imperative messages (e.g., `fix: address build error`, `feat: add editor timeline`). Keep changes focused.
- PRs: Provide a summary, linked issues, and screenshots/GIFs for UI changes. Include steps to verify locally and any config/data prerequisites.
- Checks: PRs should lint, typecheck, and build successfully.

## Security & Configuration Tips
- Store secrets in `.env.local` only. Typical keys: NextAuth secret/URL, Stripe, provider creds.
- Avoid logging secrets; scrub PII in debug output. Client-side Firebase config is public; server creds must remain private.
