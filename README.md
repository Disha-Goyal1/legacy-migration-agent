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

Run the engine tests and backend TypeScript check:

```powershell
npm test
npx tsc --noEmit
```

Type-check and build the dashboard:

```powershell
npm run build:dashboard
```

To preview the production build locally, keep the backend running and start a second terminal:

```powershell
npm run preview:dashboard
```

## Migration boundaries

Migration is conservative and not a guarantee that arbitrary JavaScript will become equivalent TypeScript. Uncertain parameters, ambiguous operators, dynamic behavior, unsupported CommonJS patterns, or transformations that may alter interoperability are called out for human review. Review the report and run application-specific tests before adopting generated code.
