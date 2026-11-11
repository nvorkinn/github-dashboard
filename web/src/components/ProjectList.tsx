import { type Project, promoteTag, type RunActions } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { RunAction } from "./RunAction.tsx";

/**
 * One row per project, with its latest release, and buttons to release it and promote that release. With `onToggle`
 * a project can be hidden: it then leaves the rows (and the page's other lists) and waits under them to be shown again.
 */
export function ProjectList({
  projects,
  now,
  hidden,
  onToggle,
}: {
  projects: Project[];
  now: number;
  /** The `owner/name` of each hidden project. */
  hidden?: ReadonlySet<string> | undefined;
  /** Hides a shown project, shows a hidden one. */
  onToggle?: ((repo: string) => void) | undefined;
}) {
  const actions = useActions()?.runs;
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.filter((project) => !hidden?.has(project.repo));
  const away = sorted.filter((project) => hidden?.has(project.repo));
  return (
    <section class="panel" aria-labelledby="projects-heading">
      <div class="panel-heading">
        <h2 id="projects-heading">
          Projects &amp; releases <span class="count">{shown.length}</span>
        </h2>
      </div>
      {shown.length === 0 ? (
        <p class="empty">{away.length === 0 ? "No projects" : "Every project is hidden"}</p>
      ) : (
        <ul class="rows">
          {shown.map((project) => (
            <li key={project.repo} class="project">
              <div class="project-name">
                <ExternalLink href={project.url} title={project.repo}>
                  {project.name}
                </ExternalLink>
                {project.private && <span class="badge">Private</span>}
              </div>
              <div class="project-release">
                {project.latestRelease ? (
                  <>
                    <a class="tag" href={project.latestRelease.url}>
                      {project.latestRelease.tag}
                    </a>
                    <span class="quiet">
                      <Ago at={project.latestRelease.publishedAt} now={now} />
                    </span>
                  </>
                ) : (
                  <span class="quiet">no release yet</span>
                )}
              </div>
              {(actions || onToggle) && (
                <div class="actions project-actions">
                  {actions && <ProjectActions project={project} actions={actions} />}
                  {onToggle && (
                    <button
                      type="button"
                      class="action secondary hide-project"
                      aria-label={`Hide ${project.name}`}
                      title="Take this project's pull requests and release workflows off the page"
                      onClick={() => onToggle(project.repo)}
                    >
                      Hide
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {away.length > 0 && (
        <div class="hidden-projects">
          <h3 id="hidden-heading">
            Hidden <span class="count">{away.length}</span>
          </h3>
          <ul aria-labelledby="hidden-heading">
            {away.map((project) => (
              <li key={project.repo}>
                <span title={project.repo}>{project.name}</span>
                {onToggle && (
                  <button
                    type="button"
                    class="action secondary"
                    aria-label={`Show ${project.name}`}
                    onClick={() => onToggle(project.repo)}
                  >
                    Show
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Release, which publishes the next minor version at once, and Promote, which starts the project's Promote workflow
 * for its latest release. Neither can be taken back, so each asks first, naming the tag.
 */
export function ProjectActions({ project, actions }: { project: Project; actions: RunActions }) {
  const promote = promoteTag(project);
  return (
    <>
      <RunAction<string>
        label="Release"
        name={`Release ${project.repo}`}
        title={`Publish the next minor release of ${project.repo}'s default branch, with notes GitHub writes`}
        busy={`Releasing ${project.name}…`}
        prepare={() => actions.nextRelease(project)}
        ask={(tag) => `Release ${project.repo} as ${tag} from its default branch?`}
        run={async (tag) => {
          await actions.release(project, tag);
          return `Released ${project.repo} as ${tag}.`;
        }}
      />
      {promote && (
        <RunAction
          label={`Promote ${promote}`}
          name={`Promote ${project.repo} ${promote} to production`}
          title={`Deploy ${project.repo} ${promote} to production with Promote workflow ${project.promoteWorkflow}, once it is approved there`}
          busy={`Promoting ${project.name}…`}
          ask={() => `Promote ${project.repo} ${promote} to production?`}
          run={async () => {
            await actions.promote(project, promote);
            return `Promotion of ${project.repo} ${promote} to production started.`;
          }}
        />
      )}
    </>
  );
}
