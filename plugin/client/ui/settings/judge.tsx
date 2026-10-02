import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsAction, SettingsInput, type SettingsInputHandle, SettingsRow } from "@getpaseo/plugin/client/ui";
import { type ReactElement, type RefObject, useRef, useState } from "react";
import { Text } from "react-native";
import { KEPT, type Layer } from "../../../shared/settings.ts";
import type { CatalogView, TeamView } from "../../../shared/views.ts";
import { sourceLabel } from "./source.ts";
import { setAttention, sourceOf, withKey } from "../../model/layer.ts";
import { Rows } from "../kit/card.tsx";
import { TabBar } from "../kit/tab-bar.tsx";
import { FONT, SPACE } from "../kit/theme.ts";

type Props = {
  catalog: CatalogView;
  team: TeamView;
  values: Layer;
  machine: Layer;
  layer: "machine" | "project";
  theme: PluginTheme;
  disabled: boolean;
  role: CatalogView["roles"][number];
  rows: ReactElement[];
  save: (change: (values: Layer) => Layer) => Promise<boolean>;
};

type Sensor = CatalogView["sensors"][number];

type Draft = { typed: string; setDraft: (text: string) => void; field: RefObject<SettingsInputHandle | null> };

/** Rows, not a component, since the card borders each child it gets; `asks` says what a paid call is spent on. */
export function keyRows(
  {
    sensor,
    values,
    machine,
    layer,
    theme,
    disabled,
    save,
    role,
  }: Pick<Props, "values" | "machine" | "layer" | "theme" | "disabled" | "save" | "role"> & { sensor: Sensor },
  { typed, setDraft, field }: Draft,
  asks: string,
): ReactElement[] {
  const kept = values.sensor?.[sensor.id]?.key === KEPT || machine.sensor?.[sensor.id]?.key === KEPT;
  const write = (key: string | null) => {
    void save((current) => withKey(current, sensor.id, key)).then((saved) => {
      // The typed key is the owner's only copy, so it is cleared only once saved.
      if (!saved) return;
      setDraft("");
      field.current?.replaceText("");
    });
  };
  const model = (
    <SettingsRow key={`${sensor.id}:sensor`} label="Sensor" hint={`From catalog/sensor. ${sensor.terms}`}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{sensor.model}</Text>
    </SettingsRow>
  );
  if (layer === "project") {
    return [
      <SettingsRow
        key={`${sensor.id}:key`}
        label={sensor.key}
        hint={`Kept on this machine for every project. Add, replace or forget it under Machine defaults, on the ${role.label}.`}
      >
        <Text style={{ color: kept ? theme.colors.foreground : theme.colors.statusWarning, fontSize: 14 }}>
          {kept ? "set" : "not set"}
        </Text>
      </SettingsRow>,
      model,
    ];
  }
  return [
    <SettingsInput
      key={`${sensor.id}:key`}
      ref={field}
      label={sensor.key}
      hint={
        kept
          ? "Kept on this machine and never shown again. Type another to replace it."
          : `${sensor.label} asks nothing without one.`
      }
      secureTextEntry
      onChangeText={setDraft}
      disabled={disabled}
    />,
    <SettingsAction
      key={`${sensor.id}:save`}
      label={kept ? "Replace the key" : "Save the key"}
      hint={`A key starts paid calls, ${asks}.`}
      actionLabel="Save key"
      onPress={() => write(typed)}
      disabled={disabled || typed.length === 0}
    />,
    ...(kept
      ? [
          <SettingsAction
            key={`${sensor.id}:forget`}
            label="Forget the key"
            hint={`${sensor.label} asks nothing more until there is a key again.`}
            actionLabel="Forget key"
            onPress={() => write(null)}
            disabled={disabled}
          />,
        ]
      : []),
    model,
  ];
}

/** Inside a judging role's line: which brains read what the watch sees, then the sensor's key and this seat's agent. */
export function JudgeRows(props: Props) {
  const { catalog, team, values, machine, layer, theme, disabled, role, rows, save } = props;
  const [draft, setDraft] = useState("");
  const field = useRef<SettingsInputHandle>(null);
  const { brain } = team.attention;
  const sensor = catalog.sensors.find((entry) => entry.id === team.attention.sensor);
  const named = sensor?.label ?? "The sensor";
  const options = [
    { id: "off", label: "Off" },
    { id: "sensor", label: named },
    { id: "seat", label: `${role.label} seat` },
    { id: "both", label: "Both" },
  ];
  const reads = brain === "sensor" || brain === "both";
  const judges = brain === "seat" || brain === "both";
  const note = judges
    ? `One ${role.label} per project, seated under the Supervisor when it first has something to judge, and let go once no lane is open.${brain === "both" ? ` It judges only what ${named} flags or leaves unsure.` : ""}`
    : `No ${role.label} is seated. What is set for the ${role.label} seat is kept for when it judges again.`;
  return (
    <Rows theme={theme}>
      <SettingsRow
        label="Brains"
        hint={`Which brains read what the watch's eye sees. Both: ${named} sifts, the ${role.label} judges. ${sourceLabel(
          sourceOf(values, machine, (entry) => entry.attention?.brain, layer),
          layer,
        )}.`}
      >
        <TabBar
          theme={theme}
          active={brain}
          disabled={disabled}
          onPick={(next) => void save((current) => setAttention(current, { brain: next as typeof brain }))}
          tabs={options}
        />
      </SettingsRow>
      {reads && sensor
        ? keyRows(
            { ...props, sensor },
            { typed: draft.trim(), setDraft, field },
            "one at each moment the watch asks about",
          )
        : null}
      {judges ? rows : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.small, padding: SPACE.lg }}>{note}</Text>
    </Rows>
  );
}
