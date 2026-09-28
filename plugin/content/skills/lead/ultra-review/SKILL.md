---
name: ultra-review
compatibility: Needs python3; uses the ocr CLI, with jq to hand it the files it selects, when both are installed.
description: "Hunts bugs across one named scope with ten independent read-only hunters, or packs the scope for an outside reviewer, with Open Code Review selecting the files and grouping them by review rule. Use when risky work is about to land, a missed bug would cost more than ten hunters, or someone outside the project is to review code they won't clone, who gets it as one packed file. Not for reviewing one change, which is one reviewer."
---

# Ultra review

**hunt**, the default, is for recall: a false positive costs a verification step and a missed bug costs far more, so no candidate leaves the report for being speculative, unique, low-confidence or duplicated, and verification is your ruling after the report exists. **pack** gives a reviewer outside the project one file it can read without the repository. The scripts own file selection, hunter assignment and the report's layout; your judgment goes into concerns, focuses and rulings. Everything this skill writes goes under `$SEATWORKS_STATE/ultra-review/`, never into the repository.

## 1. Scope

```sh
ocr delegate preview --format json --commit "$sha" > "SCRATCH/ocr-preview.json"   # or --from BASE --to "$sha"
ocr scan --preview --path PATH,PATH --format json > "SCRATCH/ocr-preview.json"     # an area, no diff
ocr delegate rule --format json $(jq -r '(.reviewable_files // [.files[] | select(.will_review)])[].path' "SCRATCH/ocr-preview.json") > "SCRATCH/ocr-rules.json"
```

SCRATCH is your scratch directory. Skip the rule call when nothing is reviewable. `ocr` filters by file type, so an excluded file is not cleared; the hunt script keeps it in scope. Without `ocr` or `jq`, say so and run the scripts without the two JSON files.

Keep the brief the hunters will be given — the scope, the change intent, the contracts that govern it and its directives `D01`, `D02`, ... — with `note` in ultra-review as `NAME-brief.md`, which puts it at `$SEATWORKS_STATE/ultra-review/NAME-brief.md` for the scripts. The report stamps its sha256, so a later round can tell which brief it reviewed. Without directives, write concerns `G01`, `G02`, ... from repository contracts, change intent, call paths, lifecycle, data flow and blast radius, and pass their number as `--concern-count` in place of `--directive-count`, so the hunters are given them.

## 2a. hunt

```bash
python3 "$SEATWORKS_KIT/content/skills/lead/ultra-review/scripts/create_ultra_review_report.py" \
  --workspace "$(git rev-parse --show-toplevel)" --report-dir "$SEATWORKS_STATE/ultra-review" \
  --review-name NAME --scope "SCOPE" --review-brief "$SEATWORKS_STATE/ultra-review/NAME-brief.md" --directive-count N \
  --ocr-preview "SCRATCH/ocr-preview.json" --ocr-rules "SCRATCH/ocr-rules.json"
```

It writes this round's report beside earlier ones, with a coverage ledger, and prints the units (each rule group with its files and rule text, plus the excluded files) and each hunter's units and directives: two hunters per unit, three per directive. Give a risky unit a third hunter yourself.

Hunters read the lane branch, or a task's branch when started with that `task`. When the scope is a task not yet accepted, start `hunter-01` to `hunter-10` in one turn, each with `start_review`, that task and that title; otherwise with no task. Each focus carries:

- the scope, change intent and relevant repository contracts;
- its units' files and rule text, and its directives and concerns, each with a search angle no other hunter on that unit has, because copies of one focus find the same bugs twice;
- warnings from earlier rounds: confirmed fixes, rejected false positives, open routes; a rejection warns, never filters;
- static inspection only: run nothing that builds or tests, since ten hunters building at once collide;
- the ask: every candidate, speculative ones included, as a hand-back finding: `P0`–`P3` as severity, `file:line` as where, the plausible failure with its evidence, broken contract and confidence as failure, the durable fix hypothesis as fix, a read-only check that would disprove it as confirmedBy; and in its answer, each assigned file reviewed, or skipped with why.

End your turn. Share no candidate before consolidation, and restart only a hunter that went silent without handing back, under its original title and assignment. `cut` each hunter once its findings are in the report. Then fill the report's TODOs, keeping it with `note` in ultra-review under its own name: each file's coverage status, findings `F001`, `F002`, ... grouped by root cause with the fields above and no raw candidate list, one Verification Queue line per finding, and the strongest reason not to merge yet; with no candidates, `No candidates reported.` under Findings.

## 2b. pack

```bash
python3 "$SEATWORKS_KIT/content/skills/lead/ultra-review/scripts/review_pack.py" create --root "$(git rev-parse --show-toplevel)" \
  --ocr-preview "SCRATCH/ocr-preview.json" --ocr-rules "SCRATCH/ocr-rules.json" \
  --include AGENTS.md --exclude-tests --task "BRIEF" --out "$SEATWORKS_STATE/ultra-review/NAME-review.md" --dry-run
```

It packs the reviewable files with the change's diff, turns each rule group into a reviewer question, and writes the reviewer prompt. Add `--focus` for an excluded file that carries behavior and `--include` for each governing document the reviewer needs to judge the architecture. For a large or architecture review, `--format zip` builds a source snapshot without the diff, prompt beside it, so the reviewer reads source truth, not a patch. Then build without `--dry-run`, and name the file count and size in your `report`: how big a pack to hand outside is yours to judge.

## Ends in

- **hunt:** the report. Fill its Rulings table: a confirmed finding becomes a task in `add_tasks` whose context names the finding IDs, whose hints point where it was found, and whose acceptance includes its disconfirming check; a rejected one keeps its row with your reason.
- **pack:** the file and its prompt, named in `report`, for the Supervisor to decide where they go.
