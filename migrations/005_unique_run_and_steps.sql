-- migrations/005_unique_run_and_steps.sql
-- Enforce a single run per repo+issue and a single step checkpoint per
-- (run, role, iteration, step). Deduplicates any pre-existing rows first so
-- the unique indexes can be created on a clean table.

-- UP:
DELETE FROM run_outcomes a
USING run_outcomes b
WHERE a.repo = b.repo
  AND a.issue_number = b.issue_number
  AND (
    a.started_at < b.started_at
    OR (a.started_at = b.started_at AND a.run_id < b.run_id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS run_outcomes_repo_issue_key
  ON run_outcomes (repo, issue_number);

DELETE FROM agent_steps a
USING agent_steps b
WHERE a.run_id = b.run_id
  AND a.role = b.role
  AND a.iteration = b.iteration
  AND a.step_name = b.step_name
  AND (
    (a.started_at IS NULL AND b.started_at IS NOT NULL)
    OR (a.started_at IS NOT NULL AND b.started_at IS NOT NULL AND a.started_at < b.started_at)
    OR (a.started_at IS NOT DISTINCT FROM b.started_at AND a.step_id < b.step_id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS agent_steps_run_role_iteration_step_key
  ON agent_steps (run_id, role, iteration, step_name);

-- DOWN:
DROP INDEX IF EXISTS agent_steps_run_role_iteration_step_key;
DROP INDEX IF EXISTS run_outcomes_repo_issue_key;
