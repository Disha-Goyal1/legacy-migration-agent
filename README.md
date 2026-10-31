# Legacy Migration Agent

A local JavaScript-to-TypeScript migration engine with a React dashboard. The dashboard calls the real `migrateFile` AST engine through a local Node.js API; uploaded source is parsed and transformed, never executed.

## Requirements

- Node.js 20 or newer
- npm

The project uses local, open-source dependencies only. The dashboard does not load external fonts, use paid APIs, or send source to a hosted service.

## Install

From the project directory:

```powershell
npm install
```

## Run the dashboard

Open two terminals in the project directory.

Terminal 1 — start the local migration API:

```powershell
npm run backend
```

The API listens on `127.0.0.1:4179`.

Terminal 2 — start the Vite dashboard:

```powershell
npm run dashboard
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5173`). The Vite development server proxies API requests to the local backend.

The dashboard loads fixture files from `fixtures/legacy` or accepts a `.js` upload up to 1 MB. It displays the generated TypeScript and the real report's status, transformations, warnings, and errors. The generated output can be downloaded from the results panel.

Uploads are held in a temporary directory only for the migration request and removed afterward. The original source is not modified or executed. The API binds to loopback by default and rejects non-JavaScript filenames and oversized request bodies.

## Run the migration engine

To migrate the checked-in fixtures and write their outputs and reports:

```powershell
npm test
```

The fixture batch writes successful or review-required TypeScript outputs beneath `fixtures/migrated`, per-file reports under `fixtures/migrated/reports`, and an aggregate `fixtures/migrated/migration-report.json`. Invalid source is reported as failed without writing an output.

## Test and build

Run the TypeScript check and migration tests first, then regenerate the checked-in
fixture outputs and reports:

```powershell
npm test
```

The tests compare each valid fixture migration to its checked-in expected output,
confirm the original inputs remain unchanged, and verify a clean Git revert when
post-migration verification fails. The malformed fixture also verifies that a
failed migration preserves any pre-existing output.

Run the migration success-rate quality gate and type-check/build the dashboard:

```powershell
npm run quality:gate
npm run build:dashboard
```

The quality gate measures successful migrations across the three valid fixtures;
the intentionally malformed fixture is excluded. It requires a 100% success rate.
GitHub Actions records a per-run summary and a 90-day JSON artifact to make the
rate reviewable across workflow runs.

The GitHub Actions workflow runs on pull requests and pushes to `main`. It runs
`npm ci`, the migration tests and fixture regeneration, the success-rate gate,
and the dashboard production build. It does not claim or run AWS integration
tests; no AWS services are invoked by this local CI workflow.

To preview the production build locally, keep the backend running and start a second terminal:

```powershell
npm run preview:dashboard
```

## Migration boundaries

Migration is conservative and not a guarantee that arbitrary JavaScript will become equivalent TypeScript. Uncertain parameters, ambiguous operators, dynamic behavior, unsupported CommonJS patterns, or transformations that may alter interoperability are called out for human review. Review the report and run application-specific tests before adopting generated code.
