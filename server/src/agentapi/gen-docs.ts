// Prints the filter-code reference (Markdown) from the live filter registry, for docs/AGENT-API.md.
//   bun run server/src/agentapi/gen-docs.ts > /tmp/filters.md
import { COLUMNS, VIEWS } from "../screener/columns";
import { FILTERS, filterCode } from "../screener/filters";
import { customSyntax } from "./service";

const MAX_OPTIONS = 40;
const esc = (s: string) => s.replace(/\|/g, "\\|");
const GROUPS = ["descriptive", "fundamental", "technical", "news", "etf"] as const;

export function filterReference(): string {
  const out: string[] = [];
  for (const g of GROUPS) {
    out.push(`#### ${g[0]!.toUpperCase()}${g.slice(1)}`, "", "| Code | Filter | Options (`<code>_<option>`) | Custom range |", "|---|---|---|---|");
    for (const f of FILTERS.filter((x) => x.group === g)) {
      const code = filterCode(f);
      let opts: string;
      if (!f.available) opts = `_unavailable: ${esc(f.unavailableReason ?? "no data")}_`;
      else if (f.dynamic && !f.options.length) opts = "_values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_";
      else {
        const shown = f.options.slice(0, MAX_OPTIONS).map((o) => `\`${esc(o.value)}\``).join(" ");
        opts = shown + (f.options.length > MAX_OPTIONS ? ` … (+${f.options.length - MAX_OPTIONS} more)` : "")
          + (f.dynamic ? " + universe values" : "");
      }
      const custom = f.custom && f.available ? `\`${customSyntax(code, f.custom.unit).replace(/ \(.*\)$/, "")}\` (${f.custom.unit})` : "";
      const scope = f.appliesTo === "all" ? "" : ` _(${f.appliesTo}s)_`;
      out.push(`| \`${code}\` | ${esc(f.label)}${scope} | ${opts} | ${custom} |`);
    }
    out.push("");
  }
  out.push("#### Sort columns (`o=`) and views (`v=`)", "");
  out.push(COLUMNS.map((c) => `\`${c.id}\``).join(" "), "");
  out.push("| View | Columns |", "|---|---|");
  for (const v of VIEWS) out.push(`| \`${v.id}\` | ${v.columns.join(", ")} |`);
  return out.join("\n");
}

if (import.meta.main) console.log(filterReference());
