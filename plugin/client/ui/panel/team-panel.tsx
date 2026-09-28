import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FlowLane, FlowSeat, FlowTask, FlowView } from "../../../shared/flow-views.ts";
import type { CatalogView } from "../../../shared/views.ts";
import { type Answers, laneLine, marked, sandboxLine, seatLine, seatName, taskLine } from "../../format/flow.ts";
import type { Tone } from "../../format/tone.ts";
import { caseLines, incidentLines, judgeWords } from "../../format/watch.ts";
import { useFlow } from "../../state/flow.ts";
import { useWorkspaceProject } from "../../state/workspace-project.ts";
import { DisclosureList, type DisclosureItem } from "../kit/disclosure.tsx";
import { Dot, toneColor } from "../kit/mark.tsx";
import { FONT, SPACE, pressState, useStyles } from "../kit/theme.ts";

const EVERY_MS = 5000;

type Navigation = PluginWorkspacePanelProps["navigation"];

const roleLabel = (catalog: CatalogView, can: string, fallback: string) =>
  catalog.roles.find((role) => role.can.includes(can))?.label ?? fallback;

/** One seat under its lane: a dot, who, what it does, and a line when no OS sandbox holds it; pressing it opens its chat. */
function SeatLine({
  who,
  line,
  seat,
  navigation,
  theme,
}: {
  who: string;
  line: { tone: Tone; text: string };
  seat: FlowSeat | null;
  navigation: Navigation;
  theme: PluginTheme;
}) {
  const styles = useStyles(theme, (colors) => ({
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: SPACE.sm, paddingVertical: 5 },
    who: { flex: 1, fontSize: FONT.small, color: colors.foreground },
    what: { fontSize: FONT.small, color: colors.foregroundMuted },
    note: { fontSize: FONT.small, color: colors.foregroundMuted, paddingLeft: 14 },
  }));
  const agentId = seat?.id;
  const open = agentId && navigation ? () => navigation.openAgent({ agentId }) : undefined;
  const sandbox = sandboxLine(seat);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${who}: ${line.text}`}
        disabled={!open}
        onPress={open}
        style={({ pressed }) => [styles.row, pressState(false, pressed && Boolean(open))]}
      >
        <Dot tone={line.tone} theme={theme} size={6} />
        <Text style={styles.who} numberOfLines={1}>
          {who}
        </Text>
        <Text style={[styles.what, { color: line.tone === "done" ? toneColor(theme, "done") : undefined }]}>
          {line.text}
        </Text>
      </Pressable>
      {sandbox ? (
        <Text style={styles.note} numberOfLines={2}>
          {sandbox}
        </Text>
      ) : null}
    </View>
  );
}

/** The brief a task works to, under its seat: its goal, then what is open to question and what nobody knows yet. */
function BriefLines({ brief, theme }: { brief: FlowTask["brief"]; theme: PluginTheme }) {
  const muted = { fontSize: FONT.small, color: theme.colors.foregroundMuted, paddingLeft: 14 };
  const lines = [
    brief.goal,
    ...(brief.choices.length > 0 ? [`Chosen, open to question: ${brief.choices.join("; ")}`] : []),
    ...(brief.unknowns.length > 0 ? [`Not known yet: ${brief.unknowns.join("; ")}`] : []),
    ...(brief.settled ? ["Builds to what is settled"] : []),
  ];
  return (
    <View style={{ paddingBottom: 4 }}>
      {lines.map((line) => (
        <Text key={line} style={muted} numberOfLines={2}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function laneItem(
  lane: FlowLane,
  flow: FlowView,
  answers: Answers,
  navigation: Navigation,
  theme: PluginTheme,
): DisclosureItem {
  const line = laneLine(
    lane,
    flow.questions.some((question) => question.lane === lane.id),
    answers,
  );
  return {
    id: lane.id,
    title: `${lane.id} ${lane.title}`,
    leading: <Dot tone={line.tone} theme={theme} />,
    trailing: <Text style={{ fontSize: FONT.small, color: toneColor(theme, line.tone) }}>{line.text}</Text>,
    body: (
      <View>
        <SeatLine
          who={seatName(lane.lead)}
          line={seatLine(lane.lead, answers)}
          seat={lane.lead}
          navigation={navigation}
          theme={theme}
        />
        {lane.tasks.map((task) => (
          <View key={task.id}>
            <SeatLine
              who={`${task.peer ? seatName(task.peer) : task.kind} ${task.id}`}
              line={taskLine(task, answers)}
              seat={task.peer}
              navigation={navigation}
              theme={theme}
            />
            <BriefLines brief={task.brief} theme={theme} />
          </View>
        ))}
        {marked(lane.kept).map((seat) => (
          <SeatLine
            key={seat.id}
            who={`${seatName(seat)} ${seat.task}`}
            line={seatLine(seat, answers)}
            seat={seat}
            navigation={navigation}
            theme={theme}
          />
        ))}
      </View>
    ),
  };
}

/** The team at a glance beside Files and Changes: a line a lane, opened in place to its seats. */
function TeamList({
  slug,
  catalog,
  human,
  navigation,
  theme,
}: {
  slug: string;
  catalog: CatalogView;
  human: boolean;
  navigation: Navigation;
  theme: PluginTheme;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { flow, error } = useFlow(slug, true, EVERY_MS, open ?? "");
  const styles = useStyles(theme, (colors) => ({
    head: { paddingHorizontal: SPACE.xs, fontSize: FONT.small, color: colors.foregroundMuted },
    note: { paddingHorizontal: SPACE.xs, fontSize: FONT.small, color: colors.foregroundMuted },
  }));
  if (error) return <Text style={[styles.note, { color: theme.colors.statusDanger }]}>{error}</Text>;
  if (!flow) return <Text style={styles.note}>Reading the team.</Text>;
  const supervisor = roleLabel(catalog, "supervise", "whoever supervises");
  const answers = { human, supervisor };
  const working = flow.lanes.filter((lane) => !lane.landed);
  const landed = flow.lanes.filter((lane) => lane.landed);
  const items = working.map((lane) => laneItem(lane, flow, answers, navigation, theme));
  if (landed.length > 0)
    items.push({
      id: "landed",
      title: `${landed.length} landed`,
      dimmed: true,
      leading: <Dot tone="done" theme={theme} />,
      body: (
        <View>
          {landed.map((lane) => (
            <Text key={lane.id} style={styles.note}>{`${lane.id} ${lane.title}`}</Text>
          ))}
        </View>
      ),
    });
  const judgeRole = roleLabel(catalog, "judge", "role that judges");
  const judge = judgeWords(flow.watch.judge, judgeRole);
  const counts = [...incidentLines(flow.watch.incidents, supervisor), ...caseLines(flow.watch.cases, judgeRole)];
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.head}>{`${slug} · ${working.length} line${working.length === 1 ? "" : "s"}`}</Text>
      {marked([...flow.supervisors, ...(flow.watch.seat ? [flow.watch.seat] : [])]).map((seat) => (
        <SeatLine
          key={seat.id}
          who={seatName(seat)}
          line={seatLine(seat, answers)}
          seat={seat}
          navigation={navigation}
          theme={theme}
        />
      ))}
      {items.length > 0 ? (
        <DisclosureList items={items} open={open} theme={theme} compact onOpen={setOpen} />
      ) : (
        <Text style={styles.note}>No lane is open.</Text>
      )}
      <Text style={styles.note}>{[judge.title, ...counts].join(" · ")}</Text>
    </View>
  );
}

/** Seatworks' tab beside Files and Changes: view only, since every decision is a card in the Supervisor's chat. */
export function TeamPanel({ workspaceId, theme, layout, navigation }: PluginWorkspacePanelProps) {
  const found = useWorkspaceProject(workspaceId);
  const pad = layout.compact ? SPACE.lg : SPACE.md;
  const muted = { fontSize: FONT.small, color: theme.colors.foregroundMuted };
  return (
    <ScrollView contentContainerStyle={{ padding: pad, gap: SPACE.md }}>
      {found.status === "project" ? (
        <TeamList slug={found.slug} catalog={found.catalog} human={found.human} navigation={navigation} theme={theme} />
      ) : (
        <Text style={found.status === "error" ? { ...muted, color: theme.colors.statusDanger } : muted}>
          {found.status === "error"
            ? found.error
            : found.status === "none"
              ? "This project does not use Seatworks. Add it from the Seatworks page."
              : "Reading the team."}
        </Text>
      )}
    </ScrollView>
  );
}
