import type { Kit } from "../../catalog/kit/kit.ts";
import { supportsRole } from "../../catalog/kit/harness-files.ts";
import { templateRoles } from "../../catalog/team/mcp-states.ts";
import type { CatalogView } from "../../../shared/views.ts";

export function describeCatalog(kit: Kit): CatalogView {
  return {
    roles: kit.roles.map((role) => ({
      id: role.role,
      label: role.label,
      description: role.description ?? "",
      can: role.can ?? [],
      defaults: role.defaults,
      follows: role.follows ?? null,
      harnesses: Object.values(kit.harnesses)
        .filter((harness) => supportsRole(kit, harness, role))
        .map((harness) => harness.id),
    })),
    harnesses: Object.values(kit.harnesses).map((harness) => ({
      id: harness.id,
      label: harness.label,
      models: harness.models ?? [],
      transports: harness.mcp.transports,
    })),
    mcp: Object.values(kit.mcp)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.description ?? "",
        settings: entry.settings,
        roles: templateRoles(entry),
      })),
    sensors: Object.values(kit.sensors).map((sensor) => ({
      id: sensor.id,
      label: sensor.label,
      key: sensor.key,
      model: sensor.model,
      terms: sensor.terms,
    })),
    kitSensor: kit.sensors[kit.attention.sensor] ? kit.attention.sensor : null,
  };
}
