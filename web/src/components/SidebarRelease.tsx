import type { Project, RunActions } from "../model.ts";
import { unreleasedUrl } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { Icon } from "./Icon.tsx";
import { ProjectActions } from "./ProjectList.tsx";

/** How many changes wait for a release: pull requests when they are known, else commits; undefined when unknown. */
export function waiting(project: Project): number | undefined {
  const unreleased = project.unreleased;
  if (!project.latestRelease || unreleased === undefined) {
    return undefined;
  }
  return unreleased.commits === 0 ? 0 : unreleased.pulls || unreleased.commits;
}

/**
 * The latest release under a repository's name in the sidebar: its tag and age, or that there is none yet. Hidden from
 * screen readers, so the row keeps a short name: the release controls next to it say the same.
 */
export function SidebarReleaseLine({ project, now }: { project: Project; now: number }) {
  const release = project.latestRelease;
  return (
    <span class="workspace-repo-release" aria-hidden="true">
      {release ? (
        <>
          <span class="workspace-repo-tag">{release.tag}</span>
          <span aria-hidden="true">·</span>
          <Ago at={release.publishedAt} now={now} />
        </>
      ) : (
        "no release yet"
      )}
    </span>
  );
}

/**
 * The button at the end of a repository's sidebar row that opens its release controls: `↑N` in amber when changes
 * wait for a release, a quiet tick when the release has everything, a quiet tag when there is no release yet.
 */
export function SidebarReleaseToggle({
  project,
  open,
  controls,
  onToggle,
}: {
  project: Project;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const count = waiting(project);
  const state = count === undefined ? "unknown" : count === 0 ? "current" : "pending";
  const said =
    count === undefined
      ? project.latestRelease
        ? "release state unknown"
        : "no release yet"
      : count === 0
        ? "up to date"
        : `${count} unreleased`;
  return (
    <button
      type="button"
      class={`workspace-release-toggle release-${state}`}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`Release controls for ${project.name}, ${said}`}
      title={`Release controls: ${said}`}
      onClick={onToggle}
    >
      {state === "pending" ? (
        <>
          <span aria-hidden="true">↑</span>
          {count}
        </>
      ) : (
        <Icon name={state === "current" ? "check" : "release"} size={14} />
      )}
    </button>
  );
}

/**
 * A repository's release controls, unfolded under its sidebar row: what waits to go out, Release and Promote.
 * `onStarted` hears when a release or promotion has started, so the drawer can fold away: the run shows on the page.
 */
export function SidebarReleaseDrawer({
  id,
  project,
  actions,
  onStarted,
}: {
  id: string;
  project: Project;
  actions: RunActions | undefined;
  onStarted?: () => void;
}) {
  const count = waiting(project);
  const release = project.latestRelease;
  const tag = release && (
    <a class="tag" href={release.url}>
      {release.tag}
    </a>
  );
  const compare = unreleasedUrl(project);
  const branch = project.defaultBranch ?? "the default branch";
  const unit = project.unreleased?.pulls ? "pull request" : "commit";
  return (
    <section id={id} class="workspace-release-drawer" aria-label={`Release controls for ${project.name}`}>
      <p class="workspace-release-summary">
        {tag === undefined ? (
          "No release yet."
        ) : count === undefined ? (
          <>Latest release {tag}</>
        ) : count === 0 ? (
          <>
            {tag} has everything on {branch}.
          </>
        ) : (
          <>
            <strong>
              {count} {count === 1 ? unit : `${unit}s`}
            </strong>{" "}
            on {branch} since {tag}
            {compare && (
              <>
                {" "}
                <ExternalLink href={compare} class="workspace-release-compare">
                  Compare
                </ExternalLink>
              </>
            )}
          </>
        )}
      </p>
      {actions && (
        <div class="actions workspace-release-actions">
          <ProjectActions project={project} actions={actions} onStarted={onStarted} />
        </div>
      )}
    </section>
  );
}
