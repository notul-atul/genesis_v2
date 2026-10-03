# Genesis: AI app builder for HighLevel

Describe a HighLevel app in chat and Genesis writes the code. The code streams into the editor as it is written, and the finished app runs in a live preview against your real HighLevel **Contacts, Conversations and Calendars** data.

| | |
|---|---|
| **App (Firebase Hosting)** | https://genesis-v2-b77b9.web.app |
| **Cloud Functions base URL** | https://us-central1-genesis-v2-b77b9.cloudfunctions.net/api |
| **OAuth redirect URI** | https://genesis-v2-b77b9.web.app/api/oauth/callback |
| **Loom walkthrough** | _TODO: add link_ |

Stack: Vue 3 + TypeScript + shadcn-vue + Monaco · Firebase Auth, Firestore, Cloud Functions (2nd gen) · OpenAI (`openai` SDK, streaming, `gpt-5.5`).

```
/functions   Cloud Functions: one Express app (`api`) with REST, SSE, OAuth, and the HighLevel proxy
  src/hl/          OAuth, encrypted token storage + refresh, server HL client, preview proxy
  src/projects/    project CRUD, files, snapshots/restore (content-addressed storage)
  src/generation/  context building, OpenAI streaming, incremental parser, validation, SSE
  templates/       system prompt (HighLevel API reference) + starter app incl. hl-client.js
/frontend    Vue 3 SPA: auth, dashboard, 3-panel workspace (chat · editor · preview)
firebase.json, .firebaserc, firestore.rules, firestore.indexes.json
```

---

## How it works

1. **Connect HighLevel.** `POST /oauth/start` creates a single-use `state` tied to your Firebase user. HighLevel then redirects to `/api/oauth/callback` (a Hosting rewrite to the function). The function exchanges the code for tokens and stores them in `hlTokens/{uid}`, encrypted with AES-256-GCM and readable only by the server. Tokens are refreshed when close to expiry.
2. **Generate.** `POST /projects/:id/generate` takes a per-project lock, gathers bounded context and streams the model's output. The context includes the current files, recent chat, and live HighLevel facts: location, calendars, and which contact fields are populated. An incremental parser splits the output into prose and `<file path="…">` blocks, which are forwarded as SSE events. At the end, the parsed output is validated into file operations, written as blobs, and committed together with a **snapshot** in one batch.
3. **Preview.** The browser bundles the project into an iframe `srcdoc`, using an import map of `data:` URL modules (no build server). The generated code calls **real HighLevel v2 paths** (`GET /contacts/`, `GET /calendars/events`, …) through `hl-client.js`. In the preview, the base URL points at `/hl-proxy`, and the app authenticates with a 1-hour **preview token** signed with HMAC and scoped to user + project + location. The proxy swaps in the user's OAuth token. Point the same code at `services.leadconnectorhq.com` with a real token and it works as a marketplace app.

### SSE event protocol

| event | data |
|---|---|
| `meta` | `{ generationId, model }` |
| `status` | `{ phase: context \| thinking \| generating \| validating \| saving }` |
| `text` | `{ delta }`: assistant prose for the chat |
| `file_start` | `{ path, action: create \| update }` |
| `token` | `{ path, delta }`: file content, streamed into Monaco |
| `file_end` | `{ path, bytes }` |
| `file_delete` | `{ path }` |
| `done` | `{ generationId, status: completed \| partial \| cancelled, snapshotId, operations, warnings, rejected }` |
| `error` | `{ code, message, retryable, partial: { applied, snapshotId } }` |

A `: ping` comment is sent every 15 s. The client uses `fetch` + `ReadableStream` rather than `EventSource`, because the request is a POST that needs an `Authorization` header.

### Failure handling

- **Malformed LLM output:** unsafe paths, oversized files, unclosed blocks and code fences are rejected or repaired. JS/JSON syntax errors are kept but reported as warnings, so the user can say "fix it".
- **Interrupted stream:** files that completed are validated and saved as a `partial` snapshot. The incomplete file is reported, and the raw output is stored on the generation document.
- **Client disconnects:** the server keeps generating and persisting. The UI says "Connection interrupted", follows the generation document in Firestore (progress is written about every 2 s), and catches up when it finishes. Reloading mid-generation reattaches the same way.
- **Cancel:** sets `cancelRequested` on the generation document. The streaming instance watches that document, aborts the OpenAI request, and keeps the files that were complete.
- **HighLevel API errors:** `hl-client.js` retries 429/5xx and raises `HLApiError`. The prompt requires loading, empty and error states with Retry in every view. The proxy refreshes and retries once on 401. The preview's console and network panel shows every HighLevel call, and **Fix with AI** sends the errors back to the model.

---

## HighLevel setup

1. Create a developer account at https://developers.gohighlevel.com and a **sandbox** (test) sub-account from the developer dashboard. Seed it with some contacts, a calendar with upcoming appointments, and a few SMS/email conversations.
2. **My Apps → Create App:** type **Private**, distribution **Sub-account**.
3. **Auth → Scopes:** `contacts.readonly contacts.write conversations.readonly conversations.write conversations/message.readonly conversations/message.write calendars.readonly calendars/events.readonly calendars/events.write locations.readonly`
4. **Auth → Redirect URLs:** add `https://genesis-v2-b77b9.web.app/api/oauth/callback`. For the emulator, also add `http://127.0.0.1:5001/genesis-v2-b77b9/us-central1/api/oauth/callback`.
5. Create a **client key** and copy the Client ID and Secret. Put the ID in `functions/.env` (`HL_CLIENT_ID`) and the secret in Secret Manager (see below).
6. In Genesis, click **Connect HighLevel** on the dashboard and pick the sandbox location.

> Redirect URLs must not contain "highlevel", "ghl" or similar words, which is one reason this uses the Hosting domain.

## Local setup (emulators)

Requires Node 22+, Java 21 (for the Firestore emulator), and `npm i -g firebase-tools`.

```bash
# backend
cd functions
npm install
cp .env.example .env                         # set HL_CLIENT_ID
cp .secret.local.example .secret.local       # OPENAI_API_KEY, HL_CLIENT_SECRET, APP_SECRET
printf 'APP_URL=http://localhost:5173\nHL_REDIRECT_URI=http://127.0.0.1:5001/genesis-v2-b77b9/us-central1/api/oauth/callback\n' > .env.local
npm run build
cd ..
firebase emulators:start --only functions,firestore,auth   # Emulator UI at http://127.0.0.1:4000

# frontend (second terminal)
cd frontend
npm install
cp .env.example .env                          # Firebase web config
cp .env.emulator.example .env.development.local
npm run dev                                   # http://localhost:5173
```

Tests: `npm test` in `functions/` covers the stream parser (every chunk size), validation, crypto and preview tokens. `npm test` in `frontend/` covers the preview bundler.

## Deployment notes

One-time setup:

1. Firebase project `genesis-v2-b77b9` on the **Blaze** plan. Functions need outbound network access and Secret Manager.
2. Enable **Email/Password** sign-in. Firestore uses a **named database, `genesis-v2`** (us-central1).
3. Secrets:
   ```bash
   firebase functions:secrets:set OPENAI_API_KEY
   firebase functions:secrets:set HL_CLIENT_SECRET
   firebase functions:secrets:set APP_SECRET      # e.g. openssl rand -base64 48
   ```
4. Optional: add a Firestore TTL policy on `expiresAt` for the `rateLimits` and `oauthStates` collections.

Deploy everything (the predeploy hooks build the functions and the frontend):

```bash
firebase deploy --only firestore,functions,hosting
```

- The `api` function runs in **us-central1**, because Hosting rewrites to functions require that region. It has `timeoutSeconds: 1800` for long generations and `concurrency: 40`.
- The SPA calls the function URL **directly**, not through the Hosting rewrite, so the CDN never buffers SSE. Only the OAuth callback goes through Hosting, which keeps the redirect URI stable.
- There is no CI/CD yet. A GitHub Action running `npm test` plus `firebase deploy` with a service account would be the next step.

---

## Architecture decisions

1. **Server-authoritative writes, rules-guarded reads.** Clients read only their own data through realtime Firestore listeners; the rules check `ownerId`. Every mutation goes through the API, which validates and keeps manifests, blobs and snapshots consistent. The cost is a round trip per write; the benefit is that a client can never corrupt project state.
2. **Content-addressed storage.** File contents are blobs keyed by SHA-256. A project, and each snapshot, is just a `path → hash` manifest. Snapshotting every generation is therefore nearly free, unchanged files are stored once, restore is a manifest swap, and diffs are hash comparisons. Documents also stay well under Firestore's 1 MiB limit.
3. **Non-destructive history.** Restore creates a *new* snapshot. Saved edits that aren't in any snapshot are backed up automatically first, so nothing is ever lost.
4. **A text protocol for files, not JSON or tool calls.** `<file path>` blocks stream token by token straight into the editor, and a truncated response still yields every complete file. A tool call's JSON would have to be fully closed before it could be parsed safely. The parser holds back only the minimal tail that could still turn out to be a tag.
5. **Generated code calls real HighLevel paths through a transparent proxy.** The OAuth token never reaches the browser or the iframe. The same code becomes a real marketplace app by changing only `baseUrl` and `token`. The proxy allow-lists the four API areas and blocks DELETE.
6. **Client-side preview bundling** (import map + `data:` modules) instead of Sandpack or WebContainers. Rebuilds are instant and nothing depends on a third-party bundler. The trade-off is that generated apps are constrained to no-build ES modules: Vue from a CDN plus Tailwind.
7. **The preview iframe is sandboxed without `allow-same-origin`.** Generated code can't read the Firebase session. It only gets a short-lived preview token scoped to user + project + location.
8. **Disconnects are not cancellations.** Cancellation is an explicit flag on the generation document; a dropped connection is not. The server finishes and persists, and the UI recovers through Firestore. The trade-off is that tokens keep being spent if the user simply leaves.
9. **Bounded, cache-friendly prompting.** A static system prompt containing the curated HighLevel API reference comes first, so OpenAI's automatic prompt caching applies (`prompt_cache_key`). Reasoning effort defaults to `low`: higher effort reasons silently for minutes before the first token, which hurts the streaming UX and risks idle-connection drops. Per-request context (files, history, live HighLevel facts) has budgets and timeouts, and HighLevel failures degrade to "unavailable" instead of blocking generation.
10. **One function for all routes:** REST, SSE, OAuth, and the proxy. Cold starts, secrets and CORS live in one place. Expensive routes are rate-limited across instances through Firestore, the proxy per instance in memory. The cost is less granular scaling.

## What I would improve

1. **Webhooks:** an `INSTALL` plus `ContactCreate` webhook receiver that fans events out to previews over Firestore, so generated apps can react live.
2. **Smaller edits:** search/replace patches instead of whole-file rewrites, to reduce tokens and latency on large apps.
3. **Automatic verification loop:** run the preview headlessly after generation, feed console and HighLevel errors back to the model once, and only then show the result.
4. **Marketplace packaging:** generate the HighLevel custom-page SSO handshake and a tiny token backend, so "Export" produces a deployable marketplace app.
5. **CI/CD and observability:** GitHub Actions for tests and deploy, per-generation cost tracking from `usage`, and alerting on generation failure rates.
