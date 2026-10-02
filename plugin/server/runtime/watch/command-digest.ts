import { createHash } from "node:crypto";
import { oneLine } from "../../core/text.ts";

/**
 * A command whole on one line with what `secretString` finds masked, as its quote shows it before the cut, and its
 * digest: what tells two whole commands apart where their cut quotes cannot, with no secret the watch knows hashed.
 */
export function commandMask(secretString: RegExp): {
  masked: (text: string) => string;
  digest: (text: string) => string;
} {
  const secrets = new RegExp(secretString.source, `${secretString.flags.replace("g", "")}g`);
  const masked = (text: string) => oneLine(text.replace(secrets, "…"), Infinity);
  return { masked, digest: (text) => createHash("sha256").update(masked(text)).digest("hex") };
}
