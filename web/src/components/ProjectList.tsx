import { type Project, promoteTag, type RunActions } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { useActions } from "./actions.tsx";
import { RunAction } from "./RunAction.tsx";

/** One row per project, with its latest release, and buttons to release it and promote that release. */
export function ProjectList({ projects, now }: { projects: Project[]; now: number }) {
  const actions = useActions()?.runs;
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section class="panel" aria-labelledby="projects-heading">
      <div class="panel-heading">
        <h2 id="projects-heading">
          Projects &amp; releases <span class="count">{projects.length}</span>
        </h2>
      </div>
      {sorted.length === 0 ? (
        <p class="empty">No projects</p>
      ) : (
        <ul class="rows">
          {sorted.map((project) => (
            <li key={project.repo} class="project">
              <div class="project-name">
                <a href={project.url} title={project.repo}>
                  {project.name}
                </a>
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
              {project.description && <p class="project-description quiet">{project.description}</p>}
              {actions && <ProjectActions project={project} actions={actions} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Release, which publishes the next minor version at once, and Promote, which starts the project's Promote workflow
 * for its latest release. Neither can be taken back, so each asks first, naming the tag.
 */
function ProjectActions({ project, actions }: { project: Project; actions: RunActions }) {
  const promote = promoteTag(project);
  return (
    <div class="actions project-actions">
      <RunAction<string>
        label="Release"
        name={`Release ${project.name}`}
        title={`Publish the next minor release of ${project.defaultBranch}, with notes GitHub writes`}
        busy="Releasing…"
        prepare={() => actions.nextRelease(project)}
        ask={(tag) => `Release ${tag}?`}
        run={async (tag) => {
          await actions.release(project, tag);
          return `Released ${tag}.`;
        }}
      />
      {promote && (
        <RunAction
          label={`Promote ${promote}`}
          name={`Promote ${project.name} ${promote}`}
          title={`Deploy ${promote} to production with the Promote workflow, once it is approved there`}
          busy="Starting…"
          ask={() => `Promote ${promote}?`}
          run={async () => {
            await actions.promote(project, promote);
            return `Promote of ${promote} started.`;
          }}
        />
      )}
    </div>
  );
}
