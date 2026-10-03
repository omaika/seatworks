import { findMarked } from "../../server/core/marked-processes.ts";

for (const { pid } of await findMarked("PASEO_AGENT_ID", process.argv[2]!, new AbortController().signal))
  console.log(`found ${pid}`);
