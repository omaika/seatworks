import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { createRef, type ReactElement, type RefObject, useRef, useState } from "react";
import { Text } from "react-native";
import { modelsRpc } from "../../../shared/rpc.ts";
import { type Layer, type RoleChoice } from "../../../shared/settings.ts";
import type { CatalogView, ModelsRefreshed, TeamView } from "../../../shared/views.ts";
import { message } from "../../format/error.ts";
import {
  modelRow,
  reviewOptions,
  setHitl,
  setLanguage,
  setReviewSensor,
  setRole,
  sourceOf,
} from "../../model/layer.ts";
import { Rows } from "../kit/card.tsx";
import { DisclosureList } from "../kit/disclosure.tsx";
import { JudgeRows, keyRows } from "./judge.tsx";
import { type KeyDrafts, reviewLine } from "../../model/key-rows.ts";
import { LevelsSection } from "./levels.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { sourceLabel } from "./source.ts";

type Props = {
  catalog: CatalogView;
  team: TeamView;
  values: Layer;
  machine: Layer;
  layer: "machine" | "project";
  theme: PluginTheme;
  disabled: boolean;
  save: (change: (values: Layer) => Layer) => Promise<boolean>;
  reload: () => void;
};

/** The models are Paseo's: it asks each agent, and this asks Paseo to do it again. */
function ModelsCard({ catalog, disabled, reload }: Pick<Props, "catalog" | "disabled" | "reload">) {
  const refresh = useRpc(modelsRpc);
  const [busy, setBusy] = useState(false);
  const [listed, setListed] = useState<ModelsRefreshed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = (id: string) => catalog.harnesses.find((entry) => entry.id === id)?.label ?? id;
  const failed = listed ? Object.entries(listed).filter(([, entry]) => entry.error) : [];
  const hint = listed
    ? Object.entries(listed)
        .map(([id, entry]) => `${label(id)} ${entry.count}`)
        .join(" · ")
    : catalog.harnesses.map((entry) => `${entry.label} ${entry.models.length}`).join(" · ");
  return (
    <SettingsCard>
      <SettingsAction
        label="Models"
        hint={`Listed by Paseo: ${hint}`}
        error={error ?? (failed.length ? failed.map(([id, entry]) => `${label(id)}: ${entry.error}`).join("\n") : null)}
        actionLabel={busy ? "Asking" : "Refresh"}
        disabled={disabled || busy}
        onPress={() => {
          setBusy(true);
          setError(null);
          refresh({})
            .then((next) => {
              setListed(next);
              reload();
            })
            .catch((problem) => setError(message(problem)))
            .finally(() => setBusy(false));
        }}
      />
    </SettingsCard>
  );
}

type Role = CatalogView["roles"][number];

/** Rows, not a component: the card borders each child it gets. */
function roleRows({
  catalog,
  team,
  values,
  machine,
  layer,
  theme,
  disabled,
  save,
  role,
}: Omit<Props, "reload"> & { role: Role }): ReactElement[] {
  const seat = team.roles[role.id];
  const follows = role.follows ? catalog.roles.find((entry) => entry.id === role.follows)?.label : undefined;
  const harness = catalog.harnesses.find((entry) => entry.id === seat?.harness);
  const models = harness?.models ?? [];
  const model = seat?.model ?? models[0]?.id ?? "";
  const row = modelRow(model, models);
  const stray = row.stray;
  const thinking = models.find((entry) => entry.id === model)?.thinkingOptions ?? [];
  const source = (field: keyof RoleChoice) =>
    sourceOf(values, machine, (entry) => entry.roles?.[role.id]?.[field], layer);
  const rows: ReactElement[] = [
    <SettingsSelect
      key="agent"
      label="Agent"
      hint={sourceLabel(source("harness"), layer, follows)}
      value={seat?.harness ?? role.defaults.harness}
      options={role.harnesses.map((id) => ({
        label: catalog.harnesses.find((entry) => entry.id === id)?.label ?? id,
        value: id,
      }))}
      onValueChange={(next) => void save((current) => setRole(current, role.id, { harness: next }, true))}
      disabled={disabled}
    />,
  ];
  if (models.length > 1 || stray) {
    rows.push(
      <ModelPicker
        key="model"
        label="Model"
        hint={
          stray
            ? `${model} is not one this agent offers. Pick one it does.`
            : sourceLabel(source("model"), layer, follows)
        }
        value={row.value}
        options={row.options}
        theme={theme}
        onValueChange={(next) => void save((current) => setRole(current, role.id, { model: next }))}
        disabled={disabled}
      />,
    );
  } else if (models.length === 1) {
    rows.push(
      <SettingsRow key="model" label="Model" hint={`${harness?.label ?? "This agent"} runs one model.`}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{models[0].label}</Text>
      </SettingsRow>,
    );
  }
  if (thinking.length > 0) {
    rows.push(
      <SettingsSelect
        key="thinking"
        label="Thinking"
        hint={sourceLabel(source("thinking"), layer, follows)}
        value={seat?.thinking ?? thinking[0].id}
        options={thinking.map((entry) => ({ label: entry.label, value: entry.id }))}
        onValueChange={(next) => void save((current) => setRole(current, role.id, { thinking: next }))}
        disabled={disabled}
      />,
    );
  }
  return rows;
}

/** The Human is the same in every project, so their language is the machine's; a seated Supervisor keeps the one it started with. */
function languageRows(
  { values, disabled, save }: Props,
  typed: string | null,
  setTyped: (text: string | null) => void,
) {
  const changed = typed !== null && typed.trim() !== (values.language ?? "");
  return [
    <SettingsInput
      key="language"
      label="Your language"
      hint="The Supervisor speaks to you in it, on every agent; the rest of the team writes English, which the watch reads. Empty, it speaks as its prompt does. A Supervisor seated now keeps the one it started with."
      initialValue={values.language ?? ""}
      onChangeText={setTyped}
      disabled={disabled}
    />,
    ...(changed
      ? [
          <SettingsAction
            key="language-save"
            label="Unsaved change"
            actionLabel="Save"
            disabled={disabled}
            onPress={() =>
              void save((current) => setLanguage(current, typed)).then((kept) => {
                if (kept) setTyped(null);
              })
            }
          />,
        ]
      : []),
  ];
}

/** First on Team, since it says whether anything reaches the Human at all; the daily limit and language are the machine's. */
function HitlCard(props: Props) {
  const { team, values, machine, layer, disabled, save } = props;
  const [language, setLanguageTyped] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const count = Number(typed?.trim());
  const changed = typed !== null && typed.trim() !== String(team.hitl.questionsPerDay);
  const wrong = changed && (!typed.trim() || !Number.isInteger(count) || count < 0);
  return (
    <SettingsCard>
      <SettingsSwitch
        label="Human in the loop"
        hint={`Off, only the concept is yours: the Supervisor grills you on it and decides everything else. On, it may queue questions for you and landings wait on your ask-first paths. ${sourceLabel(
          sourceOf(values, machine, (entry) => entry.hitl?.on, layer),
          layer,
        )}.`}
        value={team.hitl.on}
        onValueChange={(next) => void save((current) => setHitl(current, { on: next }))}
        disabled={disabled}
      />
      {layer === "machine" ? (
        <SettingsInput
          label="Questions a day"
          hint={`While you are in the loop, at most this many questions reach you a day, across every project; one that cannot be undone or that your ask-first paths raise is counted but never held back. ${sourceLabel(
            sourceOf(values, machine, (entry) => entry.hitl?.questionsPerDay, layer),
            layer,
          )}.`}
          initialValue={String(team.hitl.questionsPerDay)}
          onChangeText={setTyped}
          disabled={disabled}
        />
      ) : null}
      {layer === "machine" ? languageRows(props, language, setLanguageTyped) : null}
      {layer === "machine" && changed ? (
        <SettingsAction
          label={wrong ? "That needs a whole number" : "Unsaved change"}
          error={wrong ? "That needs a whole number, 0 or more" : null}
          actionLabel="Save"
          disabled={disabled || wrong}
          onPress={() =>
            void save((current) => setHitl(current, { questionsPerDay: count })).then((kept) => {
              if (kept) setTyped(null);
            })
          }
        />
      ) : null}
    </SettingsCard>
  );
}

/** Inside a reviewing role's line: which sensor asks review's one-condition checks, apart from the watch's brains. */
function ReviewRows(props: Props & { role: Role }) {
  const { catalog, team, values, machine, layer, disabled, save } = props;
  const [held, setHeld] = useState<KeyDrafts>({});
  const fields = useRef(new Map<string, RefObject<SettingsInputHandle | null>>());
  const { value, asks, rows, drafts } = reviewLine(catalog.sensors, team, values, machine, layer, held);
  if (drafts !== held) setHeld(drafts);
  const draftOf = (id: string) => {
    let field = fields.current.get(id);
    if (!field) fields.current.set(id, (field = createRef()));
    const setDraft = (text: string) => setHeld((current) => ({ ...current, [id]: text }));
    return { typed: (drafts[id] ?? "").trim(), setDraft, field };
  };
  return (
    <Rows theme={props.theme}>
      <SettingsSelect
        label="Review's checks"
        hint={`The sensor that asks the one-condition checks a Lead reads as evidence at a hand-back and a review; with no key they are recorded as not asked, and Off asks none, whatever the Watcher's brains read. ${sourceLabel(
          sourceOf(values, machine, (entry) => entry.review?.sensor, layer),
          layer,
        )}.`}
        value={value}
        options={reviewOptions(catalog.sensors, catalog.kitSensor, machine, layer)}
        onValueChange={(next) => void save((current) => setReviewSensor(current, next || undefined))}
        disabled={disabled}
      />
      {rows.flatMap(({ sensor, asked }) => keyRows({ ...props, sensor, asked }, draftOf(sensor.id), asks))}
    </Rows>
  );
}

/** A seat's line says what it runs on and where that comes from, so most lines never need opening. */
function seatSummary({ catalog, team, values, machine, layer }: Props, role: Role): string {
  const seat = team.roles[role.id];
  const harness = catalog.harnesses.find((entry) => entry.id === seat?.harness);
  const model = harness?.models.find((entry) => entry.id === seat?.model);
  const thinking = model?.thinkingOptions?.find((entry) => entry.id === seat?.thinking);
  const follows = role.follows ? catalog.roles.find((entry) => entry.id === role.follows)?.label : undefined;
  const from = sourceLabel(
    sourceOf(values, machine, (entry) => entry.roles?.[role.id], layer),
    layer,
    follows,
  );
  return [harness?.label ?? seat?.harness, model?.label ?? seat?.model, thinking?.label, from]
    .filter(Boolean)
    .join(" · ");
}

/** Whether the Human is in the loop, then one line a seat that opens to its agent, model and what only that role has. */
export function TeamSection(props: Props) {
  const { catalog, theme } = props;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <SettingsSection title="Human in the loop">
        <HitlCard {...props} />
      </SettingsSection>
      <SettingsSection title="Seats" info="Each role's agent, model and thinking; a role's own settings open with it.">
        <DisclosureList
          theme={theme}
          open={open}
          onOpen={setOpen}
          items={catalog.roles.map((role) => ({
            id: role.id,
            title: role.label,
            hint: seatSummary(props, role),
            flush: true,
            body: (
              <Rows theme={theme}>
                {role.can.includes("judge") ? (
                  <JudgeRows {...props} role={role} rows={roleRows({ ...props, role })} />
                ) : (
                  roleRows({ ...props, role })
                )}
                {role.can.includes("review") ? <ReviewRows {...props} role={role} /> : null}
              </Rows>
            ),
          }))}
        />
      </SettingsSection>
      {props.layer === "machine" ? <LevelsSection {...props} /> : null}
      <SettingsSection title="Models">
        <ModelsCard catalog={catalog} disabled={props.disabled} reload={props.reload} />
      </SettingsSection>
    </>
  );
}
