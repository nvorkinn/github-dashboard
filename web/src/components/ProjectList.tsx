import type { Project } from "../model.ts";
import { Ago } from "./Ago.tsx";

/** One row per project, with its latest release. */
export function ProjectList({ projects, now }: { projects: Project[]; now: number }) {
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
