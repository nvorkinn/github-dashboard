import type { Project, PullRequest, ReleaseRun } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { ProjectActions } from "./ProjectList.tsx";
import { PullRow, sortPulls } from "./PullList.tsx";
import { ReleaseCard, shownRuns, sortRuns } from "./ReleaseList.tsx";

/**
 * One lane per shown project, holding its release buttons, its runs going on now and its open pull requests; a lane
 * with none of either shrinks to its name. The hidden projects wait in a dock after the lanes, each a button that
 * brings its lane back. On a wide screen the lanes stand two abreast.
 */
export function LanesView({
  projects,
  pulls,
  runs,
  now,
  hidden,
  onToggle,
}: {
  projects: Project[];
  /** Every open pull request, of hidden projects too: the dock counts theirs. */
  pulls: PullRequest[];
  runs: ReleaseRun[];
  now: number;
  hidden: ReadonlySet<string>;
  onToggle: (repo: string) => void;
}) {
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.filter((project) => !hidden.has(project.repo));
  const away = sorted.filter((project) => hidden.has(project.repo));
  const going = sortRuns(shownRuns(runs, now));
  const pullsOf = (repo: string) => pulls.filter((pull) => pull.repo === repo);
  return (
    <div class="lanes">
      {shown.length === 0 && (
        <p class="empty lanes-empty">{away.length === 0 ? "No projects" : "Every project is hidden"}</p>
      )}
      {shown.map((project) => (
        <Lane
          key={project.repo}
          project={project}
          runs={going.filter((run) => run.repo === project.repo)}
          pulls={sortPulls(pullsOf(project.repo), "newest")}
          now={now}
          onHide={() => onToggle(project.repo)}
        />
      ))}
      {away.length > 0 && (
        <section class="dock" aria-labelledby="dock-heading">
          <h2 id="dock-heading">
            Hidden <span class="count">{away.length}</span>
          </h2>
          <ul>
            {away.map((project) => {
              const count = pullsOf(project.repo).length;
              return (
                <li key={project.repo}>
                  <button
                    type="button"
                    class="dock-project"
                    aria-label={`Show ${project.name}`}
                    title="Bring this project's lane back"
                    onClick={() => onToggle(project.repo)}
                  >
                    <span class="dock-name">{project.name}</span>
                    <span class="quiet">
                      {count} pull request{count === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function Lane({
  project,
  runs,
  pulls,
  now,
  onHide,
}: {
  project: Project;
  runs: ReleaseRun[];
  pulls: PullRequest[];
  now: number;
  onHide: () => void;
}) {
  const actions = useActions()?.runs;
  const quiet = runs.length === 0 && pulls.length === 0;
  const id = `lane-${project.repo.replace(/[^\w-]/g, "-")}`;
  return (
    <section class={quiet ? "lane lane-quiet" : "lane"} aria-labelledby={id}>
      <div class="lane-head">
        <h2 id={id}>
          <ExternalLink href={project.url} title={project.repo}>
            {project.name}
          </ExternalLink>
        </h2>
        <p class="lane-release">
          {project.latestRelease ? (
            <>
              <a class="tag" href={project.latestRelease.url}>
                {project.latestRelease.tag}
              </a>{" "}
              <span class="quiet">
                <Ago at={project.latestRelease.publishedAt} now={now} />
              </span>
            </>
          ) : (
            <span class="quiet">no release yet</span>
          )}
          {project.private && <span class="badge">Private</span>}
        </p>
        <div class="actions lane-actions">
          {actions && <ProjectActions project={project} actions={actions} />}
          <button
            type="button"
            class="action secondary hide-project"
            aria-label={`Hide ${project.name}`}
            title="Take this project's pull requests and release workflows off the page"
            onClick={onHide}
          >
            Hide
          </button>
        </div>
      </div>
      {quiet ? (
        <p class="lane-note quiet">Nothing running, no open pull requests</p>
      ) : (
        <>
          <div class="lane-runs">
            {runs.length === 0 ? (
              <p class="lane-note quiet">Nothing running</p>
            ) : (
              <ul class="rows" aria-label={`Runs of ${project.name}`}>
                {runs.map((run) => (
                  <ReleaseCard key={run.id} run={run} now={now} />
                ))}
              </ul>
            )}
          </div>
          <div class="lane-pulls">
            <h3>
              Pull requests <span class="quiet">{pulls.length}</span>
            </h3>
            {pulls.length === 0 ? (
              <p class="lane-note quiet">None open</p>
            ) : (
              <ul class="cards" aria-label={`Pull requests of ${project.name}`}>
                {pulls.map((pull) => (
                  <PullRow key={pull.number} pull={pull} now={now} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
