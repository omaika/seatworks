import type { Kit } from "../../catalog/kit/kit.ts";
import { providerId } from "../../catalog/kit/roles.ts";
import { toolsFor } from "../../catalog/team/mcp-states.ts";
import { type Team, rulesFor } from "../../catalog/team/team.ts";
import type { Project } from "../../desk/project/project.ts";
import type { TeamView } from "../../../shared/views.ts";

export function describeTeam(kit: Kit, team: Team, project?: Project): TeamView {
  return {
    project: project?.slug ?? null,
    errors: team.errors,
    attention: { watch: team.attention.watch, brain: team.attention.brain, sensor: team.attention.sensor },
    review: { sensor: team.review.sensor?.id ?? null },
    hitl: team.hitl,
    rules: team.rules,
    mcp: Object.fromEntries(
      Object.entries(team.mcp).map(([id, state]) => [
        id,
        {
          label: state.label,
          enabled: state.enabled,
          roles: state.roles,
          settings: state.settings,
          template: Boolean(state.entry),
          connect: state.connect ?? null,
        },
      ]),
    ),
    roles: Object.fromEntries(
      Object.entries(team.roles).map(([name, seat]) => [
        name,
        {
          harness: seat.harness.id,
          provider: providerId(kit, name, seat.harness.id),
          model: seat.model?.id ?? null,
          thinking: seat.thinking ?? null,
          mcp: seat.mcp,
          tools: Object.fromEntries(seat.mcp.map((id) => [id, toolsFor(team.mcp[id]!, seat.role)])),
          rules: rulesFor(team, name),
        },
      ]),
    ),
  };
}
