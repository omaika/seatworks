import { getPath, isRecord } from "../../core/json.ts";
import type { HarnessSpec } from "./kit.ts";

/** How a harness writes its timeline where it differs from the rest, as its harness file says. */
export type Quirks = NonNullable<HarnessSpec["timeline"]>;

/** The exit code a harness keeps beside the call rather than in its detail, where its quirks say. */
export function exitOf(item: Record<string, unknown>, field: string | undefined): number | undefined {
  const found = field && getPath(item, field.split("."));
  return typeof found === "number" ? found : undefined;
}

/** A call's detail, a shell's where Paseo left a tool the harness names a shell unread: its command taken from where it keeps it. */
export function detailOf(item: Record<string, unknown>, quirks: Quirks): Record<string, unknown> {
  const detail = isRecord(item.detail) ? item.detail : {};
  const field = typeof item.name === "string" ? quirks.shells?.[item.name] : undefined;
  if (!field || detail.type !== "unknown") return detail;
  const command = getPath(detail, field.split("."));
  return typeof command === "string" && command ? { ...detail, type: "shell", command } : detail;
}

/** A call Paseo marks as its own, or one the harness sends that is no call the seat made. */
export function pseudo(item: Record<string, unknown>, quirks: Quirks): boolean {
  const metadata = item.metadata as { synthetic?: unknown } | undefined;
  const detail = item.detail as { type?: unknown } | undefined;
  return (
    metadata?.synthetic === true ||
    (quirks.pseudoCalls ?? []).some((call) => item.name === call.name && detail?.type === call.detail)
  );
}
