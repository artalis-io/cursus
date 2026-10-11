---
name: ts-audit
description: Review TypeScript code and architecture for type safety, module boundaries, API/data contracts, React/state correctness, async + error handling, security, performance, and testing. Use when reviewing the Cursus backend (Node/Fastify) or frontend (React/Vite), or any strict-TS code.
user-invocable: true
---

# TypeScript Code & Architecture Audit Skill

Perform a comprehensive review of TypeScript code and its architecture. Tuned to
the Cursus stack: a pure-logic **Node 20 + Fastify** backend (JSON-file
store, no DB) and a **React 18 + Vite + Tailwind + shadcn/ui** frontend with
`react-map-gl/maplibre`, EN/HU i18n, and a **staged-edit "decision cockpit"**
model (read snapshot -> optimize -> tune -> explain -> hand back; NOT a system
of record).

**Target:** $ARGUMENTS

## Usage

```
/ts-audit                      # Audit the Cursus backend + frontend
/ts-audit server               # Audit server (Node/Fastify)
/ts-audit web                  # Audit web (React/Vite)
/ts-audit path/to/file.ts      # Audit a specific file
/ts-audit <target> --fix       # Audit and apply safe fixes
/ts-audit <target> --arch      # Emphasize the architecture review (section 2)
```

## How to run the review

1. **Establish the baseline (must pass before judging code):**
   - `cd server && npx tsc --noEmit` and `cd web && npm run build` (the web build runs `tsc -b`, which is stricter: `noUnusedLocals`/`noUnusedParameters`). A clean `--noEmit` does NOT imply a clean `tsc -b`.
   - `cd server && npm test` (node:test). UI: `web` Playwright runs against a LIVE app.
2. **Map the architecture** before reading line-by-line (section 2). Note the layer each file belongs to and whether it respects the boundaries.
3. **Sweep each category** (sections 1, 3-9). For every finding record: file:line, severity, the rule, and a concrete fix.
4. **Verify claims** (do not trust a grep): open the call site, confirm the type actually flows the way you think, re-run the baseline after any `--fix`.
5. **Emit the report** in the format at the end. Lead with Critical/High; call out architecture violations explicitly.

Severity: **Critical** (data loss / crash / security) > **High** (wrong behavior, broken types that mask bugs) > **Medium** (fragile, maintainability) > **Low** (style/nit).

---

## 1. Type Safety & Strictness (High)

| Issue | Pattern | Severity | Why |
|-------|---------|----------|-----|
| `any` (explicit or implicit) | `: any`, `as any`, untyped params | High | Disables all checking downstream; one `any` infects callers |
| Unsafe cast | `x as Foo`, `as unknown as Foo` | High | Lies to the compiler; a shape change won't be caught |
| Non-null assertion abuse | `x!.y` on values that can be null | High | Hides the real nullable case; crashes at runtime |
| Unvalidated external data typed as its target | `await res.json() as Plan` | High | Network/file/user data is `unknown` until validated |
| Non-exhaustive discriminated union | `switch (edit.op)` without a `never` default | Medium | A new variant compiles but is silently unhandled |
| Loose object index | `Record<string, unknown>` passed around unparsed | Medium | Defers errors to runtime |
| Mutable shared type | missing `readonly` on shared/config arrays | Low | Accidental mutation of shared state |
| `==` / truthy-guarding `0`/`''` | `if (vehicleId)` when `0` is valid | High | Falsy valid values (id 0, empty string) silently skipped |

```typescript
// BAD: trusts the wire; a backend shape drift is invisible until it crashes a render
const plan = await (await fetch(url)).json() as Plan;

// GOOD: validate at the boundary, then the type is earned
function parsePlan(x: unknown): Plan { /* check required fields, throw on mismatch */ }
const plan = parsePlan(await (await fetch(url)).json());

// BAD: `0` is a real vehicleId here (id 0 is valid in the data) -> this skips it
if (vehicleId) assign(vehicleId);
// GOOD
if (vehicleId != null) assign(vehicleId);

// GOOD: exhaustive switch catches a new ScenarioEdit variant at compile time
function apply(edit: ScenarioEdit): void {
  switch (edit.op) {
    case 'pin': /* ... */ break;
    // ...every case...
    default: { const _never: never = edit; void _never; } // compile error if a variant is unhandled
  }
}
```

**Checks**
- [ ] No `any`; `unknown` only at boundaries and narrowed before use.
- [ ] Every `as` / `as unknown as` is justified in a comment and unavoidable (e.g. a library-typing gap). Prefer a type guard.
- [ ] External input (`fetch`, `req.body`, file reads, `JSON.parse`, `localStorage`) is validated, not cast.
- [ ] Nullable checks use `!= null` so `0`/`''`/`false` are not dropped.
- [ ] Discriminated unions handled exhaustively (`never` default).
- [ ] `tsconfig` has `strict: true`, `noUncheckedIndexedAccess` considered, `noUnusedLocals`/`noUnusedParameters` (the web build enforces these).

---

## 2. Architecture & Module Boundaries (High)

The cockpit's value is that it is **orthogonal** to the customer's systems. Keep the layers honest.

| Boundary | Rule | Smell |
|----------|------|-------|
| Transport-agnostic core | Business logic is pure functions; HTTP/WASM are thin wrappers | Fastify handler computing a schedule inline |
| Backend layering | `store` (persistence) / `solve` (request build) / `plan/mapper` + `plan/evaluate` (Surge <-> Plan) / `data` (datasets) / `server` (routes) | A route mutating the store directly, or the mapper doing IO |
| Frontend layering | `components` (view) / `lib` + `map` (pure helpers) / `lib/api` (the only fetch surface) | A component calling `fetch` instead of `api.*` |
| Staged-edit model | Edits accumulate on a scenario COPY and apply on Replan; the displayed plan does NOT change until Replan (previews excepted, and labelled) | A drag that silently re-solves; the plan mutating in place |
| System-of-record creep | Out of scope: order CRUD, driver roster, live tracking, persistent plan lifecycle, audit-of-who-changed-what | A new "inbox"/"dispatched" status, per-order edit history |
| Secrets stay server-side | Rate cards / tariffs / credentials never shipped to the browser | Cost coefficients in a frontend constant |
| Single source of a value | One function owns each computation (capacity, eligibility, cost, schedule) | The same schedule math duplicated in mapper + evaluate drifting apart |

**Checks**
- [ ] A new endpoint parses + validates, delegates to a pure function, formats the response, nothing more.
- [ ] Frontend components never `fetch` directly; all network goes through `lib/api`.
- [ ] Shared contract types (`Plan`, `Scenario`, `SurgeRequest`, `ScenarioEdit`) have ONE definition the backend and frontend agree on; drift is a High finding.
- [ ] No duplicated domain math; if two paths compute the same thing, they call one function (mapper/evaluate both derive timings from the matrix the same way).
- [ ] The staged-edit invariant holds: edits fork a copy, apply on Replan, nothing re-solves implicitly.
- [ ] Nothing confidential (tariffs, keys) is reachable from the client bundle.

---

## 3. API & Data Contracts (High)

| Issue | Pattern | Severity |
|-------|---------|----------|
| Trusting request body | reading `req.body.x` without validation | Critical |
| Unbounded input | arrays/strings with no length cap | High |
| Missing 404/400 envelopes | throwing instead of `reply.code(...).send({error})` | Medium |
| Backend/frontend type drift | hand-maintained duplicate interfaces out of sync | High |
| Leaky errors | sending stack traces / internal messages to clients | Medium |
| Permutation/identity assumptions | accepting an order set without checking it matches the trip | High |

```typescript
// GOOD: validate every field of untrusted input at the edge (Fastify route)
app.post<{ Body: { vehicleId?: number; orderNos?: unknown } }>('/api/...', async (req, reply) => {
  const b = req.body ?? {};
  if (typeof b.vehicleId !== 'number') return reply.code(400).send({ error: 'vehicleId required' });
  if (!Array.isArray(b.orderNos) || b.orderNos.length === 0 || b.orderNos.length > 1000
      || !b.orderNos.every((o) => typeof o === 'string'))
    return reply.code(400).send({ error: 'orderNos must be a non-empty string[] (<=1000)' });
  // ...only now use b.vehicleId / b.orderNos...
});
```

**Checks**
- [ ] Every mutating route validates shape, types, and bounds; returns typed 400/404.
- [ ] Batch endpoints cap item counts and validate each item.
- [ ] `plan.day` is an ISO date; resolve to a day id via `allDayIds()` before `loadDay()` (a recurring trap).
- [ ] Error responses carry a safe message, never a stack or internal path.
- [ ] Shared types are imported from one module, not re-declared on each side.

---

## 4. React & State Correctness (High)

| Issue | Pattern | Severity |
|-------|---------|----------|
| Conditional hooks | hook after an early `return` / inside a branch | Critical |
| Missing effect cleanup | `fetch`/`setTimeout`/listeners not cancelled on unmount | High |
| setState after unmount / stale response | async resolves without a `cancelled`/latest-key guard | High |
| Derived state in state | `useState` + effect to mirror a prop instead of computing | Medium |
| Unstable list keys | `key={index}` on reorderable lists | High |
| Hardcoded UI text | literal strings instead of `t('...')` | Medium |
| a11y gaps | click-only handlers, no role/aria/keyboard, SVG `role=img` wrapping interactive children | High |
| Shadowed identifiers | loop var shadowing `t` (the translator) | Medium |

```tsx
// BAD: hook called after an early return -> order changes between renders
if (!plan) return <Loading/>;
const x = useMemo(...);            // <-- illegal

// GOOD: all hooks before any return; a child component owns conditional work
const preview = usePreviewTotals(plan, scenario); // called unconditionally
if (!plan) return <Loading/>;

// GOOD: cancel stale async in effects (used by the reorder preview)
useEffect(() => {
  let cancelled = false;
  api.evaluateTrip(/*...*/).then((r) => { if (!cancelled) setTrip(r.trip); }).catch(() => {});
  return () => { cancelled = true; };
}, [key]);

// GOOD: an SVG with interactive children is role=group; children are focusable role=button
<g role="button" tabIndex={0} aria-label={label} onClick={sel} onKeyDown={(e) => onKeyActivate(e, sel)} />
```

**Checks**
- [ ] Hooks are unconditional and above every early return (lift conditional work into child components).
- [ ] Every async effect cancels (AbortController or a `cancelled`/latest-key flag) and tolerates unmount.
- [ ] Derived values use `useMemo`, not state-mirroring effects.
- [ ] Reorderable lists key on a stable id (orderNo/seq), never the array index.
- [ ] All user-facing strings go through `t()` (EN + HU); assertions must not hard-code one locale.
- [ ] Interactive elements are keyboard-operable with roles/aria; `role="img"` is not used on SVG that has clickable children.
- [ ] No identifier shadows `t`/`props` inside a map callback; alias if needed.

---

## 5. Async, Errors & Resource Management (High)

| Issue | Pattern | Severity |
|-------|---------|----------|
| Floating promise | `somePromise()` not awaited or `void`-marked | Medium |
| Unhandled rejection | `fetch().then()` without `.catch` at a boundary | High |
| No cancellation | long polls / admits that keep running after the UI closed | High |
| Missing timeout | `execFile`/network with no timeout | High |
| Untyped catch | `catch (e) { e.message }` without narrowing `unknown` | Medium |
| Swallowed error | empty `catch {}` hiding a real failure | High |

```typescript
// GOOD: abortable long work; the poll stops when the panel unmounts
const ctrl = new AbortController();
admitAbort.current = ctrl;
try { await pollJob(jobId, onTick, { signal: ctrl.signal }); }
catch (e) { if ((e as Error).name === 'AbortError') return; setErr(describeApiError(e, t)); }
// cleanup: useEffect(() => () => admitAbort.current?.abort(), []);

// GOOD: subprocess with a hard timeout + bounded buffer (matrix build)
execFile(bin, args, { timeout: timeoutMs, maxBuffer: mb * 1024 * 1024 }, cb);
```

**Checks**
- [ ] Promises are awaited or explicitly `void`-marked; no floating promises.
- [ ] Every boundary (route handler, effect, event handler) has a catch that surfaces a humane, typed error.
- [ ] Long-running client work (poll/admit/solve) is abortable and aborted on unmount.
- [ ] External processes and network calls have timeouts and output bounds.
- [ ] `catch (e)` narrows `unknown` (`e instanceof Error` / typed `ApiError`), never assumes `.message`.
- [ ] No empty catches; a deliberate ignore is commented.

---

## 6. Security (Critical)

| Issue | Pattern | Severity |
|-------|---------|----------|
| CSV/formula injection | user text written to CSV without quoting leading `= + - @ \t \r` | High |
| Secrets to client | tariffs/keys/rate cards in the frontend bundle | Critical |
| Path traversal | file access from user-supplied names without validation | Critical |
| Prototype pollution | deep-merging untrusted JSON (`__proto__`) | High |
| XSS | `dangerouslySetInnerHTML` with non-sanitized input | Critical |
| Missing rate limit / backpressure | public endpoints with no limiter | Medium |
| Unbounded resource | zip entry size / matrix size / upload size not capped | High |

```typescript
// GOOD: neutralize spreadsheet formula injection without corrupting real numbers
function csvCell(s: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
```

**Checks**
- [ ] Exported CSV quotes untrusted customer/city/order text; genuine numbers (incl. negative coords) untouched.
- [ ] No confidential config reachable from the client; the demo tariff is clearly illustrative.
- [ ] File/dataset access validates the path/id; uploads, zip entries, and matrices are size-capped.
- [ ] No `dangerouslySetInnerHTML` with unsanitized data; JSON merges guard `__proto__`/`constructor`.
- [ ] Public endpoints rate-limit and shed load (429/503) under pressure.

---

## 7. Performance (Medium)

| Issue | Pattern | Severity |
|-------|---------|----------|
| Re-render storms | new object/array/function props every render into memo'd children | Medium |
| Missing memoization of heavy derives | recomputing a big FC/map each render | Medium |
| Copying large shared data | `structuredClone` of the N^2 travel matrix | High |
| Unbounded lists | rendering thousands of rows without virtualization/caps | Medium |
| Chatty network | per-keystroke/per-drag requests without debounce/keying | Medium |
| Bundle bloat | pulling a heavy dep for a trivial need | Low |

```typescript
// GOOD: share the big matrix by reference; clone only what you mutate
const { travel, ...rest } = day.request;
const request = structuredClone(rest) as SurgeRequest;
request.travel = travel; // N^2 matrix shared, never cloned
```

**Checks**
- [ ] Heavy children receive stable props (`useMemo`/`useCallback`) only where it measurably matters, not reflexively.
- [ ] Large shared structures (travel matrix) are shared by reference, never deep-cloned per request.
- [ ] Async previews/searches are keyed/debounced and drop stale responses.
- [ ] Long lists are capped or virtualized; the build flags oversized chunks are acknowledged.

---

## 8. Testing (High)

| Issue | Pattern | Severity |
|-------|---------|----------|
| Locale-coupled assertions | asserting English UI text that breaks on HU | High |
| Non-deterministic tests | relying on unseeded randomness / wall-clock | Medium |
| Untyped `app.inject` plumbing | HTTP tests fighting Fastify overloads | Low |
| Data-dependent CI tests | tests needing the external dataset running in `test:ci` | Medium |
| Missing error-path coverage | only happy paths; no 400/404/empty/oversize | High |
| Weak assertions | checking presence, not behavior/values | Medium |

```typescript
// GOOD: language-independent liveness (a lesson from the chaos monkey)
const alive = await page.locator('header').first().isVisible();   // not getByText('Served / Total')
// GOOD: isolate the per-IP rate limiter across inject() calls
const freshIp = () => `10.${(ipn >> 8) & 255}.0.${ipn++ & 255}`;
```

**Checks**
- [ ] Backend: `node:test` with HTTP coverage via `app.inject()`; data-dependent cases live in `test`, not `test:ci`.
- [ ] UI: Playwright against the live app; selectors by role/aria, not localized text; help overlay suppressed.
- [ ] Tests are seeded/deterministic; no reliance on current time or unseeded `Math.random`.
- [ ] Error paths covered (invalid/empty/oversize/unknown-id -> 400/404) alongside happy paths.
- [ ] Consider running the chaos monkey (`CHAOS=1 ... chaos.spec.ts`) for crash/overflow regressions.

---

## 9. Tooling & Config (Medium)

**Checks**
- [ ] `tsconfig`: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; the web `tsc -b` gate passes (stricter than `--noEmit`).
- [ ] ESLint present and clean, including `react-hooks/rules-of-hooks` and `exhaustive-deps` (documented, deliberate disables only).
- [ ] No dead imports/vars (they fail the web build).
- [ ] Commit messages avoid backticks in `-m` (the shell command-substitutes them; a known trap here).

---

## Audit Output Format

```markdown
# ts-audit: <target>

## Baseline
- tsc --noEmit: ✅ / ❌ (…)
- web build (tsc -b): ✅ / ❌ (…)
- tests: NN passed / MM failed

## Architecture review
- Layering: ✅/⚠️  <notes on boundary violations, duplicated domain math, SoR creep>
- Contracts: ✅/⚠️  <backend/frontend type parity>
- Staged-edit invariant: ✅/⚠️

## Findings
| # | Severity | File:Line | Issue | Fix |
|---|----------|-----------|-------|-----|
| 1 | High | web/src/... | await res.json() cast to Plan | validate at boundary |
| 2 | High | server/src/... | route reads req.body.x unvalidated | add shape/bounds checks |

## Summary
- Critical: N · High: N · Medium: N · Low: N
- Top 3 to fix now: …
- (with --fix) Applied: … · Left for review: …
```

## Notes for this codebase
- Backend is pure TS run via `tsx`; no DB (JSON-file store in `server/src/store.ts`).
- `Map` is shadowed by react-map-gl's default import in `map/MapView.tsx` — use `globalThis.Map`.
- Radix `ScrollArea` with only `max-h-[..]` does not scroll (no definite height for the `h-full` viewport); prefer a native `max-h-[..] overflow-y-auto` div.
- The displayed plan reflects the committed solve; staged edits preview via `/api/plans/:id/evaluate` (reorders only — stops unchanged) and otherwise apply on Replan.
- Keep customer data out of the repo; datasets live under `DATASET_ROOT`, never committed.
