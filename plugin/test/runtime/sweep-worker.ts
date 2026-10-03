import { stopMarked } from "../../server/core/marked-processes.ts";

for (const pid of await stopMarked("PASEO_AGENT_ID", process.argv.slice(2), new AbortController().signal))
  console.log(`stopped ${pid}`);
