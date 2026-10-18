# Candidate scenarios and acceptance-criteria mapping

This catalog describes intended coverage for the sample TodoMVC issue, not hard-coded executable test scripts. At runtime Gemini builds `evidence/generated-scenarios.json` from the current issue's acceptance criteria. The generated plan is validated for full coverage before opening the browser, so editing issue criteria changes the generated plan without authoring a `.spec.ts`.

| Acceptance criterion | Candidate scenario intention | Observable evidence sought |
|---|---|---|
| AC-01 — A new task with valid text appears in the list. | Add a fresh task through the accessible todo input. | The unique task text appears in an observed list snapshot. |
| AC-02 — A user can mark a created task complete and see its completed state. | Create a fresh task and use the observed completion control. | Snapshot shows the task completed (for example, completed item semantics/state). |
| AC-03 — The Active filter hides completed tasks and shows active tasks. | Create active/completed tasks and choose the observed Active filter. | Snapshot shows active text and excludes the completed text. |
| AC-04 — A user can remove a task and it no longer appears in the list. | Create a fresh task and remove it using the observed UI control. | A fresh snapshot no longer contains the unique task text. |

Scenario grouping, steps and actual controls are generated from the live issue. The executor must cite literal post-action observations for each AC; this table itself is not evidence of a run.
