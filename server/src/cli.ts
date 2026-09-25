// EODView admin CLI.
//   bun run server/src/cli.ts set-key <KEY>   validate against EODHD and store in server/data/config.json
//   bun run server/src/cli.ts set-key -       same, reading the key from stdin (keeps it out of shell history)
//   bun run server/src/cli.ts show            print masked key, source and plan
//   bun run server/src/cli.ts clear-key       remove the key from config.json (falls back to EODHD_API_KEY)
// A running server picks up file changes within a few seconds.
import type { ConfigView } from "@eodview/shared";
import { CONFIG_FILE, config } from "./config/config";

const USAGE = `usage: bun run server/src/cli.ts <command>
  set-key <KEY|->   validate and store the EODHD API key ("-" reads it from stdin)
  show              show the configured key (masked), its source and plan
  clear-key         remove the stored key from ${CONFIG_FILE}`;

function print(v: ConfigView): void {
  console.log(`key:     ${v.keyMasked ?? "(none)"}`);
  console.log(`source:  ${v.keySource}${v.keySource === "file" ? ` (${CONFIG_FILE})` : v.keySource === "env" ? " (EODHD_API_KEY)" : ""}`);
  if (v.plan) {
    if (v.plan.name) console.log(`plan:    ${v.plan.name}`);
    if (v.plan.apiRequests !== undefined) {
      console.log(`usage:   ${v.plan.apiRequests}${v.plan.dailyRateLimit ? ` / ${v.plan.dailyRateLimit}` : ""} requests today`);
    }
  } else if (v.hasKey) {
    console.log("plan:    (could not fetch plan info from EODHD)");
  }
  console.log(`port:    ${v.port}`);
}

async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "set-key": {
      const key = arg === "-" || arg === undefined ? await readStdin() : arg;
      if (!key) {
        console.error("no key given\n" + USAGE);
        return 2;
      }
      const view = await config.setKey(key);
      console.log(`saved EODHD key to ${CONFIG_FILE}`);
      print(view);
      return 0;
    }
    case "show":
      print(await config.view());
      return 0;
    case "clear-key":
      print(await config.clearKey());
      return 0;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return cmd === undefined ? 2 : 0;
    default:
      console.error(`unknown command "${cmd}"\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`error: ${(e as Error)?.message ?? String(e)}`);
    process.exit(1);
  },
);
