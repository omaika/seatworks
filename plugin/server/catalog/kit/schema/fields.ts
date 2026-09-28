import { z } from "zod";

export const text = z.string().min(1);
export const texts = z.array(z.string());
export const Json = z.record(z.string(), z.unknown());

/** A platform as the daemon's Node names it. */
export const Platform = z.enum(["darwin", "linux", "win32"]);
