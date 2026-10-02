import { createHash } from "node:crypto";

/**
 * The hex sha256 of a command's text exactly as run, neither masked nor cut, secrets included: two commands differing
 * only in a key differ. Only the hash is kept, and a key the watch finds is too long to guess back from it.
 */
export const commandDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
