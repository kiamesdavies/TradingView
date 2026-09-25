// Process-wide EODHD REST client. Reads the key from `config` on every call and de-duplicates
// identical in-flight requests (see factory.ts). Throws EodhdError {status, message}.
import { config } from "../config/config";
import { createEodhdClient, type EodhdClient } from "./factory";

export { EodhdError } from "./request";
export { createEodhdClient, INTRADAY_MAX_RANGE_SEC, type EodhdClient } from "./factory";
export type { EodPeriod, EodhdUser, IntradayInterval } from "./mappers";

export const eodhd: EodhdClient = createEodhdClient(() => config.getKey());
