interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Spain CNMV Regulated Filings MCP — keyless, same-day-fresh.
 *
 * Wraps the public registers of the Comisión Nacional del Mercado de Valores
 * (cnmv.es), the Spanish securities regulator and the Spanish Officially
 * Appointed Mechanism for listed-company regulated disclosures:
 *
 *   - Otra información relevante (OIR) — results, buybacks, liquidity
 *     contracts, governance, annual/half-year financial report notices, …
 *     /portal/otra-informacion-relevante/resultado-oir.aspx
 *   - Información privilegiada (IP) — inside information (MAR art. 17)
 *     /portal/informacion-privilegiada/resultado-ip.aspx
 *   - Informes financieros anuales (IFA) — the per-issuer annual financial
 *     report register, with the individual + consolidated documents and the
 *     ESEF report package (ZIP/.xbri) the issuer filed
 *     /portal/consultas/ifa/listadoifa.aspx?id=0&nif=<NIF>
 *
 * Built to replace filings.xbrl.org for Spanish issuers: that community index
 * had 1 Spanish filing for the 2025 period against 113 for 2024. The CNMV
 * registers carry filings within minutes of registration (verified 2026-09-23:
 * newest OIR row 19:48 Madrid on the same day).
 *
 * The registers are server-rendered HTML (ASP.NET WebForms). There is no JSON
 * API. Everything here is plain GETs with query parameters except the
 * company-name search, which is the site's own search form postback.
 *
 * NOTE ON "403 errorcode=CVFE": that is the CNMV portal's NOT-FOUND page (its
 * text is "Verifique la ruta" — check the path), served with status 403. A
 * nonexistent path such as /portal/nonexistent-xyz.aspx returns it too. It is
 * not a bot block; it means the URL is wrong. The pre-2020 "Hechos
 * relevantes" feed was replaced by OIR + IP on 2020-02-08.
 *
 * ⚠️ DOCUMENT INDEX, NOT XBRL FACTS. Rows are disclosure events with a title,
 * issuer, timestamp and document link. The annual-report tool returns the
 * ESEF package URL, but nothing here parses XBRL.
 *
 * ⚠️ TIMESTAMPS ARE MADRID LOCAL TIME on the source. `published_at` carries
 * the Europe/Madrid offset (+01:00 / +02:00).
 *
 * ⚠️ ISSUER KEY IS THE SPANISH NIF (e.g. "A-28092583"), not ISIN or LEI.
 * cnmv_find_issuer resolves a name or ISIN to it. Foreign issuers registered
 * with CNMV carry an "N…" NIF.
 *
 * All tools return shaped objects and never throw — failures resolve to
 * { error }.
 */


const UA = 'Pipeworx/1.0 (+https://pipeworx.io; support@pipeworx.io)';
const SRC = 'CNMV (Spain)';
const ORIGIN = 'https://www.cnmv.es';
const PAGE_SIZE = 10; // the CNMV result lists render 10 rows per page, fixed

type Feed = 'oir' | 'ip';
const FEED_PATH: Record<Feed, string> = {
  oir: '/portal/otra-informacion-relevante/resultado-oir',
  ip: '/portal/informacion-privilegiada/resultado-ip',
};
const FEED_LABEL: Record<Feed, string> = {
  oir: 'Otra información relevante',
  ip: 'Información privilegiada',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'cnmv_search_filings',
    description:
      'Search Spanish listed-company regulated disclosures filed with the CNMV (Comisión Nacional del Mercado de Valores), the Spanish securities regulator: "Otra información relevante" (results, annual and half-year financial report notices, buybacks, governance, liquidity contracts) and "Información privilegiada" (inside information). PREFER OVER esef_filing_search FOR SPANISH ISSUERS — CNMV publishes within minutes of registration, while the community ESEF index runs months behind for Spain. Filter by date window (date_from/date_to, inclusive, default last 7 days), and optionally one issuer by nif, isin or company name. Returns disclosure EVENTS — company, NIF, category, title, Madrid-time publication timestamp, registration number and document URL — NOT extracted XBRL facts. For an issuer\'s annual financial reports with their ESEF ZIP download, use cnmv_annual_reports.',
    inputSchema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'First publication day to include (YYYY-MM-DD, Madrid calendar day, inclusive). Default: 7 days before date_to.' },
        date_to: { type: 'string', description: 'Last publication day to include (YYYY-MM-DD, inclusive). Default: today.' },
        nif: { type: 'string', description: 'Issuer Spanish tax id (NIF/CIF) as CNMV records it, e.g. "A-28092583" (Técnicas Reunidas). Most precise issuer filter. Get it from cnmv_find_issuer.' },
        isin: { type: 'string', description: 'Issuer share ISIN, e.g. "ES0178165017". Resolved to the issuer NIF through the CNMV ISIN register first.' },
        company: { type: 'string', description: 'Issuer name, e.g. "Tecnicas Reunidas", "Banco Santander". Resolved to a NIF with the CNMV entity search; when several entities match, the closest name is used and the others are listed under issuer_candidates.' },
        feed: { type: 'string', enum: ['all', 'oir', 'ip'], description: '"oir" = Otra información relevante, "ip" = Información privilegiada, "all" (default) = both, merged newest first.' },
        limit: { type: ['number', 'string'], description: 'Rows to return, newest first (1-50). Default 20. To go further back, narrow the date window rather than paging.' },
      },
    },
  },
  {
    name: 'cnmv_annual_reports',
    description:
      'List a Spanish issuer\'s annual financial reports (Informes financieros anuales) from the CNMV official register: financial-year end, CNMV publication date, auditor, audit opinion, and links to the individual and consolidated reports and to the ESEF report package (ZIP/.xbri containing the iXBRL report and taxonomy files). Identify the issuer by nif, isin or company name. Covers every year the issuer has filed (back to the 2000s for long-listed issuers); ESEF packages exist from FY2020 onward.',
    inputSchema: {
      type: 'object',
      properties: {
        nif: { type: 'string', description: 'Issuer NIF as CNMV records it, e.g. "A-28092583".' },
        isin: { type: 'string', description: 'Issuer share ISIN, e.g. "ES0178165017".' },
        company: { type: 'string', description: 'Issuer name, e.g. "Tecnicas Reunidas".' },
        limit: { type: ['number', 'string'], description: 'Most recent N financial years to return (1-40). Default 5.' },
      },
    },
  },
  {
    name: 'cnmv_find_issuer',
    description:
      'Resolve a Spanish-market issuer name or ISIN to the NIF the CNMV registers use, via the CNMV entity search and ISIN register. Returns the matching entities (name + NIF) and the CNMV entity page URL. Use the NIF with cnmv_search_filings or cnmv_annual_reports.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Entity name or fragment, e.g. "Tecnicas Reunidas", "Santander".' },
        isin: { type: 'string', description: 'Security ISIN, e.g. "ES0178165017".' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'cnmv_search_filings':
        return await searchFilings(args);
      case 'cnmv_annual_reports':
        return await annualReports(args);
      case 'cnmv_find_issuer':
        return await findIssuer(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function getHtml(url: string, init?: RequestInit): Promise<{ html: string; url: string; cookies: string }> {
  const res = await fetchWithTimeout(
    url,
    {
      redirect: 'follow',
      ...init,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    },
    SRC,
  );
  const finalUrl = res.url || url;
  // The portal answers an unknown path with a redirect to its error page,
  // status 403 and errorcode=CVFE ("check the path"). Say that, rather than
  // letting it read as an access block.
  if (/errorcode=CVFE/i.test(finalUrl)) {
    throw new Error(`not_found: ${SRC} answered "check the path" (errorcode=CVFE) for ${url} — the URL or parameters are not valid on the CNMV portal.`);
  }
  if (!res.ok) throw await httpError(res, SRC);
  const html = await res.text();
  return { html, url: finalUrl, cookies: cookieHeader(res) };
}

function cookieHeader(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  return raw
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

// ── HTML helpers ────────────────────────────────────────────────────────────

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function text(s: string | undefined): string {
  if (!s) return '';
  return decode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function abs(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(decode(href), base).toString();
  } catch {
    return null;
  }
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Entity name from a CNMV register page: the subtitle span on entity pages,
 *  else the last segment of "<meta name="title" content="CNMV - <register> - <NAME>">. */
function pageEntityName(html: string): string | null {
  const sub = /id="ctl00_lblSubtitulo"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  if (sub && text(sub[1])) return text(sub[1]);
  const meta = /<meta name="title" content="([^"]*)"/.exec(html);
  if (meta) {
    const parts = decode(meta[1]).split(' - ');
    if (parts.length >= 3) return parts.slice(2).join(' - ').trim() || null;
  }
  return null;
}

// ── Dates ───────────────────────────────────────────────────────────────────

function isoDay(v: string | undefined, field: string): string | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`${field} must be YYYY-MM-DD, got "${v}".`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function toCnmvDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Europe/Madrid offset for a local wall-clock time: CEST (+02:00) from the
 *  last Sunday of March 02:00 to the last Sunday of October 03:00, else +01:00. */
function madridOffset(y: number, mo: number, d: number, h: number): string {
  const lastSunday = (month: number) => {
    const last = new Date(Date.UTC(y, month, 0)); // day 0 of the next month = last day of `month`
    return last.getUTCDate() - last.getUTCDay();
  };
  const key = mo * 10000 + d * 100 + h;
  const summer = key >= 3 * 10000 + lastSunday(3) * 100 + 2 && key < 10 * 10000 + lastSunday(10) * 100 + 3;
  return summer ? '+02:00' : '+01:00';
}

/** "26/02/2026" + "21:25" → "2026-02-26T21:25:00+01:00" */
function madridIso(date: string, time?: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const t = time ? /^(\d{1,2}):(\d{2})/.exec(time.trim()) : null;
  if (!t) return `${y}-${mo}-${d}`;
  const hh = t[1].padStart(2, '0');
  return `${y}-${mo}-${d}T${hh}:${t[2]}:00${madridOffset(+y, +mo, +d, +hh)}`;
}

function dmyToIso(date: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── Issuer resolution ───────────────────────────────────────────────────────

interface Entity { name: string; nif: string; entity_url: string }

function entityUrl(nif: string): string {
  return `${ORIGIN}/portal/consultas/datosentidad.aspx?nif=${encodeURIComponent(nif)}`;
}

/** The CNMV entity search is a WebForms postback: load the form, echo its
 *  hidden state fields back with the query. A unique match redirects to the
 *  entity page; several matches render a <select> of NIF → name. */
async function searchEntities(q: string): Promise<Entity[]> {
  const formUrl = `${ORIGIN}/portal/Consultas/BusquedaPorEntidad`;
  const form = await getHtml(formUrl);
  const body = new URLSearchParams();
  for (const m of form.html.matchAll(/<input type="hidden" name="(__[A-Z]+)" id="[^"]*" value="([^"]*)"/g)) {
    body.set(m[1], decode(m[2]));
  }
  if (!body.has('__VIEWSTATE')) throw new Error(`${SRC} entity search form changed shape (no __VIEWSTATE) — cannot search by name.`);
  // URLSearchParams encodes `$` as %24, which is what the server needs; a
  // literal `$` makes WebForms re-render the form with a 200 and no results.
  body.set('ctl00$ContentPrincipal$txtBusqueda', q);
  body.set('ctl00$ContentPrincipal$btnBuscar', 'Buscar');
  const res = await getHtml(formUrl, {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: formUrl, ...(form.cookies ? { Cookie: form.cookies } : {}) },
  });
  const direct = /datosentidad\?nif=([^&#]+)/i.exec(res.url);
  if (direct) {
    const nif = decodeURIComponent(direct[1]);
    return [{ name: pageEntityName(res.html) ?? q, nif, entity_url: entityUrl(nif) }];
  }
  const sel = /<select[^>]*lstSeleccion[^>]*>([\s\S]*?)<\/select>/i.exec(res.html);
  if (!sel) return [];
  const out: Entity[] = [];
  for (const m of sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
    const nif = decode(m[1]).trim();
    if (nif) out.push({ name: text(m[2]), nif, entity_url: entityUrl(nif) });
  }
  return out;
}

/** ISIN register: GET /portal/ancv/isin?isin=… renders a table captioned with
 *  the issuer name (no NIF), so ISIN → name → entity search. */
async function issuerNameForIsin(isin: string): Promise<string | null> {
  const { html } = await getHtml(`${ORIGIN}/portal/ancv/isin?isin=${encodeURIComponent(isin)}`);
  const cap = /<caption>([\s\S]*?)<\/caption>/i.exec(html);
  return cap ? text(cap[1]) || null : null;
}

function bestMatch(cands: Entity[], q: string): Entity | undefined {
  const fq = fold(q);
  const domestic = (c: Entity) => /^[A-HJ-NP-SUVW]-?\d{7,8}$/.test(c.nif);
  return (
    cands.find((c) => fold(c.name) === fq) ??
    // Spanish issuers are mostly "<NAME>, S.A." — prefer a domestic NIF over a foreign-listing code
    cands.find((c) => domestic(c) && fold(c.name).startsWith(fq)) ??
    cands.find((c) => fold(c.name).startsWith(fq)) ??
    cands.find((c) => domestic(c)) ??
    cands[0]
  );
}

interface Resolved { nif: string; name?: string; via: string; candidates?: Entity[] }

async function resolveIssuer(args: Record<string, unknown>): Promise<Resolved | { error: string } | undefined> {
  const nif = strArg(args.nif);
  if (nif) return { nif: nif.toUpperCase(), via: 'nif' };
  const isin = strArg(args.isin)?.toUpperCase();
  if (isin) {
    if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return { error: `isin "${isin}" is not a 12-character ISIN.` };
    const name = await issuerNameForIsin(isin);
    if (!name) return { error: `ISIN ${isin} is not in the CNMV ISIN register (it covers securities issued in Spain; foreign ISINs are not listed). Try company or nif.` };
    const cands = await searchEntities(name);
    const hit = bestMatch(cands, name);
    if (!hit) return { error: `ISIN ${isin} belongs to "${name}", but the CNMV entity search found no entity by that name. Try nif.` };
    return { nif: hit.nif, name: hit.name, via: `isin ${isin} → ${name}`, ...(cands.length > 1 ? { candidates: cands.slice(0, 10) } : {}) };
  }
  const company = strArg(args.company);
  if (company) {
    const cands = await searchEntities(company);
    const hit = bestMatch(cands, company);
    if (!hit) return { error: `No CNMV-registered entity matches "${company}". Try a shorter fragment of the legal name (e.g. "Tecnicas Reunidas", without "S.A.").` };
    return { nif: hit.nif, name: hit.name, via: `company "${company}"`, ...(cands.length > 1 ? { candidates: cands.slice(0, 10) } : {}) };
  }
  return undefined;
}

// ── Disclosure feeds (OIR / IP) ─────────────────────────────────────────────

interface Filing {
  published_at: string | null;
  published_local: string;
  company: string;
  nif: string | null;
  feed: string;
  category: string;
  title: string;
  registration_number: string | null;
  document_url: string | null;
}

interface FeedPage { rows: Filing[]; pages: number }

function parseFeedPage(html: string, pageUrl: string, feed: Feed): FeedPage {
  const rows: Filing[] = [];
  const blocks = html.split(/<li id="[^"]*_elementoPrimerNivel"/).slice(1);
  for (const b of blocks) {
    const date = text(/_liFechaRegistro"[^>]*>([\s\S]*?)<\/li>/.exec(b)?.[1]);
    const time = text(/_liHora"[^>]*>([\s\S]*?)<\/li>/.exec(b)?.[1]);
    const head = /_hlTituloCabecera" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    const cat = text(/_descripcionSubtituloCabecera"[^>]*>([\s\S]*?)<\/span>/.exec(b)?.[1]);
    const doc = /_subtituloRegistroEnlace" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    const reg = /N[úu]mero de registro:\s*(\d+)/.exec(b)?.[1] ?? null;
    const nif = head ? (/nif=([^&"]+)/i.exec(decode(head[1]))?.[1] ?? null) : null;
    rows.push({
      published_at: madridIso(date, time),
      published_local: `${date} ${time}`.trim(),
      company: text(head?.[2]),
      nif,
      feed: FEED_LABEL[feed],
      category: cat,
      title: text(doc?.[2]),
      registration_number: reg,
      document_url: abs(doc?.[1], pageUrl),
    });
  }
  const pg = /P[áa]gina\s+\d+\s+de\s+(\d+)/.exec(html);
  const pages = pg ? Number(pg[1]) : rows.length ? 1 : 0;
  return { rows, pages };
}

function feedUrl(feed: Feed, from: string, to: string, nif: string | undefined, page: number): string {
  const q: string[] = [];
  if (nif) q.push(`nif=${encodeURIComponent(nif)}`);
  // literal slashes in the dates, as the portal's own links write them
  q.push(`fechaDesde=${toCnmvDate(from)}`, `fechaHasta=${toCnmvDate(to)}`);
  if (page > 0) q.push(`page=${page}`);
  return `${ORIGIN}${FEED_PATH[feed]}?${q.join('&')}`;
}

async function fetchFeedPage(feed: Feed, from: string, to: string, nif: string | undefined, page: number): Promise<FeedPage> {
  const { html, url } = await getHtml(feedUrl(feed, from, to, nif, page));
  return parseFeedPage(html, url, feed);
}

async function readFeed(feed: Feed, from: string, to: string, nif: string | undefined, want: number): Promise<{ rows: Filing[]; total: number }> {
  const first = await fetchFeedPage(feed, from, to, nif, 0);
  const rows = [...first.rows];
  const pages = first.pages;
  let fetched = 1;
  for (; fetched < pages && rows.length < want; fetched++) {
    rows.push(...(await fetchFeedPage(feed, from, to, nif, fetched)).rows);
  }
  // Exact total = full pages + the rows on the last page. Counting the last
  // page costs one extra request, and it is what makes a date window checkable
  // (two windows → two different totals) instead of "about N".
  let total = rows.length;
  if (pages > fetched) {
    const lastCount = (await fetchFeedPage(feed, from, to, nif, pages - 1)).rows.length;
    total = (pages - 1) * PAGE_SIZE + lastCount;
  }
  return { rows, total };
}

async function searchFilings(args: Record<string, unknown>): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const to = isoDay(strArg(args.date_to), 'date_to') ?? today;
  const from = isoDay(strArg(args.date_from), 'date_from') ?? addDays(to, -7);
  if (from > to) return { error: `date_from (${from}) is after date_to (${to}).` };
  const limit = clampInt(args.limit, 20, 1, 50);
  const feedArg = (strArg(args.feed) ?? 'all').toLowerCase();
  const feeds: Feed[] = feedArg === 'oir' ? ['oir'] : feedArg === 'ip' ? ['ip'] : ['oir', 'ip'];

  const issuer = await resolveIssuer(args);
  if (issuer && 'error' in issuer) return issuer;

  const totals: Record<string, number> = {};
  const all: Filing[] = [];
  for (const f of feeds) {
    // sequential on purpose: one public regulator site, be gentle with it
    const r = await readFeed(f, from, to, issuer?.nif, limit);
    totals[f] = r.total;
    all.push(...r.rows);
  }
  all.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  const filings = all.slice(0, limit);
  return {
    total_count: Object.values(totals).reduce((s, n) => s + n, 0),
    totals_by_feed: totals,
    count: filings.length,
    date_from: from,
    date_to: to,
    ...(issuer ? { issuer: { nif: issuer.nif, name: issuer.name ?? null, resolved_via: issuer.via } } : {}),
    ...(issuer?.candidates ? { issuer_candidates: issuer.candidates } : {}),
    timezone_note: 'published_at is Madrid local time with its UTC offset; the date window is Madrid calendar days, inclusive.',
    filings,
    source: 'CNMV public registers (cnmv.es): Otra información relevante, Información privilegiada',
  };
}

// ── Annual financial reports (IFA) ──────────────────────────────────────────

async function annualReports(args: Record<string, unknown>): Promise<unknown> {
  const issuer = await resolveIssuer(args);
  if (!issuer) return { error: 'cnmv_annual_reports needs one of nif, isin or company.' };
  if ('error' in issuer) return issuer;
  const limit = clampInt(args.limit, 5, 1, 40);
  const url = `${ORIGIN}/portal/consultas/ifa/listadoifa.aspx?id=0&nif=${encodeURIComponent(issuer.nif)}`;
  const { html, url: finalUrl } = await getHtml(url);
  const grid = /<table[^>]*gridInformes[\s\S]*?<\/table>/i.exec(html)?.[0] ?? '';
  const reports: Record<string, unknown>[] = [];
  for (const tr of grid.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 9) continue;
    const reg = text(cells[0]);
    if (!/^\d+$/.test(reg)) continue;
    const href = (id: string) => abs(new RegExp(`id="[^"]*_${id}" href="([^"]*)"`).exec(tr[1])?.[1], finalUrl);
    // Pre-2021 rows carry a single scanned audit PDF linked from the register-number cell.
    const legacyPdf = /<a[^>]*href="([^"]*\.pdf)"/i.exec(cells[0])?.[1];
    const opinion = text(cells[8]).split('/').map((s) => s.trim());
    reports.push({
      registration_number: reg,
      financial_year_end: dmyToIso(text(cells[1])),
      published_on: dmyToIso(text(cells[2])),
      auditor: text(cells[3]) || null,
      individual_report_url: href('hlTipoIndividual'),
      consolidated_report_url: href('hlTipoConsolidada'),
      esef_package_url: href('hlFicheroZIP'),
      legacy_audit_pdf_url: legacyPdf ? abs(legacyPdf, finalUrl) : null,
      audit_opinion_individual: opinion[0] || null,
      audit_opinion_consolidated: opinion[1] || null,
    });
  }
  if (!reports.length) {
    return { error: `No annual financial reports found for NIF ${issuer.nif}. Check the NIF with cnmv_find_issuer (it must be the CNMV-registered form, e.g. "A-28092583"); entities that are not listed issuers have no IFA register.`, register_url: finalUrl };
  }
  return {
    issuer: { nif: issuer.nif, name: pageEntityName(html) ?? issuer.name ?? null, resolved_via: issuer.via },
    ...(issuer.candidates ? { issuer_candidates: issuer.candidates } : {}),
    total_count: reports.length,
    count: Math.min(limit, reports.length),
    register_url: finalUrl,
    reports: reports.slice(0, limit),
    note: 'published_on is the date the issuer filed the report (or its latest replacement). esef_package_url downloads the ESEF report package (ZIP, sometimes named .xbri) exactly as filed with CNMV.',
    source: 'CNMV Registro Oficial, Informes financieros anuales (cnmv.es)',
  };
}

// ── Issuer lookup ───────────────────────────────────────────────────────────

async function findIssuer(args: Record<string, unknown>): Promise<unknown> {
  const isin = strArg(args.isin)?.toUpperCase();
  const company = strArg(args.company);
  if (!isin && !company) return { error: 'cnmv_find_issuer needs company or isin.' };
  let q = company ?? '';
  let isinName: string | null = null;
  if (isin) {
    isinName = await issuerNameForIsin(isin);
    if (!isinName) return { error: `ISIN ${isin} is not in the CNMV ISIN register (securities issued in Spain only).`, isin };
    q = isinName;
  }
  const matches = await searchEntities(q);
  if (!matches.length) return { error: `No CNMV-registered entity matches "${q}". Try a shorter fragment of the legal name.`, query: q };
  return {
    query: company ?? isin,
    ...(isin ? { isin, isin_issuer_name: isinName } : {}),
    count: matches.length,
    best_match: bestMatch(matches, q) ?? null,
    matches: matches.slice(0, 25),
    source: 'CNMV entity search and ANCV ISIN register (cnmv.es)',
  };
}

// ── args ────────────────────────────────────────────────────────────────────

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
