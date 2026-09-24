# @pipeworx/cnmv-filings

Spanish listed-company regulated disclosures and annual financial reports from
the CNMV (Comisión Nacional del Mercado de Valores) public registers, including
the ESEF report packages. Filings show up within minutes of registration, not
months later as in the community ESEF index.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1678+ live data sources.

## Tools

- `cnmv_search_filings(date_from?, date_to?, nif?, isin?, company?, feed?, limit?)`
  searches disclosures by publication window (Madrid calendar days, inclusive,
  default the last 7 days). You can narrow it to one issuer. It covers
  "Otra información relevante" (results, annual and half-year report notices,
  buybacks, governance) and "Información privilegiada" (inside information),
  newest first. Each row has the company, NIF, category, title, registration
  number, a Madrid-time `published_at` and the document URL. `total_count` is
  exact for the window.
- `cnmv_annual_reports(nif? | isin? | company?, limit?)` returns the issuer's
  annual financial report register: financial-year end, publication date,
  auditor, audit opinion, the individual and consolidated report links, and the
  **ESEF report package URL** (a ZIP, sometimes named `.xbri`, holding the iXBRL
  report and taxonomy files, FY2020 onward).
- `cnmv_find_issuer(company? | isin?)` resolves a name or a Spanish ISIN to the
  NIF that the CNMV registers use.

## Why this pack exists

`esef-filings` proxies `filings.xbrl.org`. On 2026-09-23 that index held 113
Spanish filings for FY2024 and **1** for FY2025. The CNMV is the primary source
the index aggregates from. Measured the same day: Técnicas Reunidas' FY2025
annual financial report was registered 2026-02-26 21:25 Madrid time, and its
ESEF ZIP (5.5 MB, LEI `213800JEZBUPZKWJGF49`) downloads from the URL
`cnmv_annual_reports` returns. The newest OIR row in the register was 19:48 the
same day it was queried.

## ⚠️ Things a caller must know

1. **This is a document index, not an XBRL-facts API.** Nothing here parses
   the ESEF package. `esef_package_url` is there so a downstream pipeline can
   ingest it.
2. **The issuer key is the Spanish NIF** (e.g. `A-28092583`, sometimes written
   without the dash, e.g. `A39000013`). ISINs and LEIs are not the register's
   key. `isin` is resolved through the CNMV ISIN register, which lists only
   securities issued in Spain. A foreign issuer listed in Madrid has an `N…`
   NIF and no Spanish ISIN, so use `company` or `nif` for those.
3. **Name search can match several entities.** "banco santander" matches six,
   including foreign-currency listings with codes like `BRL-000356`. The pack
   picks the closest domestic name and lists the rest under
   `issuer_candidates`. Check them if the name is ambiguous.
4. **Timestamps are Madrid local time** on the source. `published_at` carries
   the +01:00/+02:00 offset. `published_local` is the raw string.

## Auth

Keyless. No account, no API key. Everything is public on cnmv.es.

## Data sources

- <https://www.cnmv.es/portal/otra-informacion-relevante/resultado-oir.aspx?fechaDesde=DD/MM/YYYY&fechaHasta=DD/MM/YYYY[&nif=…][&page=N]>
  is the "Otra información relevante" register, 10 rows per page, with a
  0-based `page`.
- <https://www.cnmv.es/portal/informacion-privilegiada/resultado-ip.aspx> is the
  "Información privilegiada" register and takes the same parameters.
- <https://www.cnmv.es/portal/consultas/ifa/listadoifa.aspx?id=0&nif=…> is the
  annual financial report register for one issuer.
- <https://www.cnmv.es/portal/Consultas/BusquedaPorEntidad> is the entity
  name search (an ASP.NET postback).
- <https://www.cnmv.es/portal/ancv/isin?isin=…> is the ISIN register.
- <https://www.cnmv.es/webservices/verdocumento/ver?t=…|e=…> is the document
  download handler (PDF / ZIP). These URLs stayed stable across page loads when
  tested.

## Gotchas

- **`403` with `errorcode=CVFE` is the portal's not-found page**, not a block.
  Its text reads "No ha sido posible completar su consulta. Verifique la ruta."
  A made-up path (`/portal/nonexistent-xyz.aspx`) returns the same response.
  The old `HR/ComunicacionesRR.aspx` and `Consultas/IFA/InformesFinancierosAnuales.aspx`
  paths return it because they do not exist. The pre-2020 "Hechos relevantes"
  feed was split into OIR and IP on 2020-02-08. The pack turns this response
  into a `not_found:` error.
- `listadoifa.aspx` without `nif` returns `400 errorcode=HE`.
- The `.aspx` URLs 301 to extensionless ones, so follow redirects.
- The OIR/IP result pages report "Página 1 de N" but no row count. The pack
  computes the exact total as `(N-1)*10 + rows on the last page`, which costs
  one extra request when the window spans more pages than `limit` needs.
- The "Últimos días" summary page (`Consultas/BusquedaUltimosDias.aspx`) counts
  **issuers** per category per day, not filings. Its numbers are lower than
  `total_count` for the same day, and that is expected.
- Entity search needs WebForms state. POST back `__VIEWSTATE`,
  `__VIEWSTATEGENERATOR` and `__EVENTVALIDATION`, form-encoded, so the `$` in
  control names goes out as `%24` (the working encoding here; a literal `$`
  was not tested on CNMV, but on other WebForms sites it silently re-renders
  the form with HTTP 200). A unique match redirects to the entity page.
  Several matches render a `select` list of NIF → name.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cnmv-filings": {
      "url": "https://gateway.pipeworx.io/cnmv-filings/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/cnmv-filings/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1678+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/cnmv_search_filings \
  -H 'Content-Type: application/json' \
  -d '{"date_from":"2026-09-21","date_to":"2026-09-23","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/cnmv_search_filings`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "cnmv-filings": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-cnmv-filings"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-cnmv-filings
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Cnmv Filings data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
