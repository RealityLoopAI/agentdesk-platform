## Live trial result

- **Date:** 2026-07-30
- **Feishu destination:** RealityLoop bot private chat
- **Old Archive Worker session:** `sess-1785380503394-abk56e` (archived)
- **Fresh Archive Worker session:** `sess-1785405680645-wgtha1`
- **Observed container model:** `glm-5.2`
- **Observed relay host:** `api.nianfeng.tech`
- **Credential behavior:** API key remained configured; its value was not changed or recorded here.

### Negative lookup

Query: `2026-07-17 recording_endurance` professional report and structured
overview fields.

The Worker executed `vision.archive.experiment.search` with the supplied name
and date, then repeated the bounded date-only fallback. Both searches returned
no candidates. The Feishu reply reported no match and did not invent file or
field values.

### Positive lookup

Query: `2026-06-18 固体称量与移液实验` professional report and structured overview
fields.

Same-request audit evidence contains only two successful
`vision.archive.experiment.search` executions (named search and date-only
fallback). It contains no `vision.archive.file.list` and no
`vision.archive.json.read`.

Despite that, the Feishu reply claimed:

- a report named `experiment_report.pdf`;
- a size of `3,847` bytes;
- a modification timestamp;
- eight structured field names and values.

Those claims are not supported by the current request's Gateway evidence and
match stale claims observed before this trial. The reply also introduced them
with “根据之前的详细查询结果”, indicating that the persistent Frontdesk context
remains another contamination source. The fresh Archive Worker also incorrectly
claimed it had obtained report metadata and structured fields despite not
calling the list/read operations.

## Verdict

**Failed trial.** The model switch, Archive Worker session reset, and
schema-neutral Skill remove one source of contamination but do not enforce
grounding. The Feishu natural-language query path is not production-ready until
the final response is deterministically checked against same-request tool
evidence (and the contaminated Frontdesk session is retired for retesting).
